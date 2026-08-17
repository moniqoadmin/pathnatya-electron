import { promises as fs } from 'fs'
import { join } from 'path'
import { app, net, safeStorage } from 'electron'
import { APP_KEY, API_BASE } from '../shared/api-config'
import { isUptimeReboot, nextBootId, readOsBootId, readUptimeSec } from './boot-id'

/** Sealed with OS safeStorage (DPAPI / Keychain). Legacy plaintext name kept for migration. */
const STATE_FILE = 'trusted-time.dat'
const LEGACY_STATE_FILE = 'trusted-time.json'
const TIME_PATH = '/health/time'
/**
 * Max |server UTC − local UTC| allowed before video is refused.
 * Both values are epoch ms (GMT/UTC); small skew covers network and scheduling jitter.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2 * 60 * 1000
/** How often to re-fetch server GMT and compare to the local clock while the app runs. */
export const CLOCK_SKEW_POLL_MS = 60_000
/** Offline downloads must re-verify server time at least this often. */
export const TRUSTED_CHECKIN_TTL_MS = 2 * 24 * 60 * 60 * 1000
/** Temporary jump applied to effective now after each offline OS reboot. */
export const OFFLINE_REBOOT_PENALTY_MS = TRUSTED_CHECKIN_TTL_MS
/** Used when the backend has not sent `numberOfReboot`. */
export const DEFAULT_NUMBER_OF_REBOOT = 3

interface TrustedTimeState {
  version: 1 | 2
  /** Server unix ms at last successful sync. */
  serverMsAtSync: number
  /** Local Date.now() at that sync. */
  localMsAtSync: number
  /** Highest unpenalized trusted "now" observed — used to detect clock rollback. */
  lastSeenTrustedMs: number
  /** OS boot id or a UUID minted for this boot. */
  bootId?: string
  /** os.uptime() seconds when this state was last written. */
  uptimeSecAtWrite?: number
  /** Extra ms added to effective now after offline reboot(s). Cleared on server sync. */
  rebootPenaltyMs?: number
  /** When true, wall clock is ignored until the next successful server sync. */
  distrustWallClock?: boolean
  /** Absolute 2-day check-in deadline from the last qualifying server sync. */
  checkInExpiresAtMs?: number
  /** Offline OS reboots since the last successful server sync. */
  offlineRebootCount?: number
  /** Max offline reboots allowed before internet is required (from the backend). */
  numberOfReboot?: number
}

interface ServerTimeResponse {
  iso?: string
  unixMs?: number
}

export type ClockSkewVerdict = {
  /** True after a successful sync where |server − local| exceeded tolerance. */
  mismatched: boolean
  /** Absolute skew in ms from the latest successful sync this process, or null. */
  skewMs: number | null
  /** True once syncTrustedTime has succeeded at least once this process. */
  checked: boolean
}

export type RebootProtectionState = {
  penaltyMs: number
  distrustWallClock: boolean
  bootId: string | null
  checkInExpiresAtMs: number | null
  offlineRebootCount: number
  numberOfReboot: number
}

let memory: TrustedTimeState | null = null
let loaded = false
/** Monotonic baseline taken at the latest sync (process-local). */
let monoNsAtSync: bigint | null = null
/** Trusted ms corresponding to `monoNsAtSync` while the wall clock is distrusted. */
let monoBaseMs: number | null = null
let persistQueue: Promise<void> = Promise.resolve()
/** Process-local: set on each successful syncTrustedTime. */
let lastSkewMs: number | null = null
let clockMismatched = false
let clockChecked = false
let skewPollTimeoutId: ReturnType<typeof setTimeout> | null = null
let skewPollInflight: Promise<void> | null = null

function statePath(): string {
  return join(app.getPath('userData'), STATE_FILE)
}

function legacyStatePath(): string {
  return join(app.getPath('userData'), LEGACY_STATE_FILE)
}

function seal(plaintext: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext)
  }

  return Buffer.from(plaintext, 'utf8')
}

function unseal(payload: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(payload)
  }

  return payload.toString('utf8')
}

function isValidState(value: unknown): value is TrustedTimeState {
  if (!value || typeof value !== 'object') {
    return false
  }

  const parsed = value as TrustedTimeState
  if (
    (parsed.version !== 1 && parsed.version !== 2) ||
    !Number.isFinite(parsed.serverMsAtSync) ||
    !Number.isFinite(parsed.localMsAtSync) ||
    !Number.isFinite(parsed.lastSeenTrustedMs)
  ) {
    return false
  }

  if (
    parsed.bootId !== undefined &&
    (typeof parsed.bootId !== 'string' || parsed.bootId.length === 0)
  ) {
    return false
  }

  if (parsed.uptimeSecAtWrite !== undefined && !Number.isFinite(parsed.uptimeSecAtWrite)) {
    return false
  }

  if (
    parsed.rebootPenaltyMs !== undefined &&
    (!Number.isFinite(parsed.rebootPenaltyMs) || parsed.rebootPenaltyMs < 0)
  ) {
    return false
  }

  if (parsed.distrustWallClock !== undefined && typeof parsed.distrustWallClock !== 'boolean') {
    return false
  }

  if (parsed.checkInExpiresAtMs !== undefined && !Number.isFinite(parsed.checkInExpiresAtMs)) {
    return false
  }

  if (
    parsed.offlineRebootCount !== undefined &&
    (!Number.isFinite(parsed.offlineRebootCount) || parsed.offlineRebootCount < 0)
  ) {
    return false
  }

  if (
    parsed.numberOfReboot !== undefined &&
    (!Number.isFinite(parsed.numberOfReboot) || parsed.numberOfReboot < 1)
  ) {
    return false
  }

  return true
}

function parseStateJson(raw: string): TrustedTimeState | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidState(parsed) ? parsed : null
  } catch {
    return null
  }
}

function withCheckInExpiry(state: TrustedTimeState): TrustedTimeState {
  if (state.checkInExpiresAtMs != null) {
    return state
  }

  return {
    ...state,
    checkInExpiresAtMs: state.serverMsAtSync + TRUSTED_CHECKIN_TTL_MS
  }
}

function persistPayload(state: TrustedTimeState): TrustedTimeState {
  return {
    ...state,
    version: 2,
    uptimeSecAtWrite: readUptimeSec()
  }
}

async function persist(state: TrustedTimeState): Promise<void> {
  persistQueue = persistQueue
    .then(async () => {
      const stamped = persistPayload(state)
      if (memory) {
        memory = { ...memory, uptimeSecAtWrite: stamped.uptimeSecAtWrite }
      }
      await fs.writeFile(statePath(), seal(JSON.stringify(stamped)))
      // Drop any leftover plaintext from older builds.
      await fs.rm(legacyStatePath(), { force: true })
    })
    .catch(() => {
      // Best-effort — expiry still works in-memory for this process.
    })
  await persistQueue
}

function beginDistrustMonoBaseline(baseMs: number): void {
  monoNsAtSync = process.hrtime.bigint()
  monoBaseMs = baseMs
}

/**
 * Load persisted offset / last-seen watermark. Safe to call repeatedly.
 * Prefers the sealed `.dat`; migrates legacy plaintext `.json` once.
 * Applies offline-reboot protection when the boot id / uptime shows a reboot.
 */
export async function loadTrustedTime(): Promise<void> {
  if (loaded) {
    return
  }

  loaded = true
  memory = null

  try {
    const sealed = await fs.readFile(statePath())
    const parsed = parseStateJson(unseal(sealed))
    if (parsed) {
      memory = withCheckInExpiry(parsed)
      await applyOfflineRebootProtection()
      return
    }
  } catch {
    // Missing or corrupt sealed file — try legacy plaintext below.
  }

  try {
    const legacyRaw = await fs.readFile(legacyStatePath(), 'utf8')
    const parsed = parseStateJson(legacyRaw)
    if (parsed) {
      memory = withCheckInExpiry(parsed)
      await persist(memory)
      await applyOfflineRebootProtection()
    }
  } catch {
    memory = null
  }
}

function applySync(serverMs: number, localMs: number): TrustedTimeState {
  const next: TrustedTimeState = {
    version: 2,
    serverMsAtSync: serverMs,
    localMsAtSync: localMs,
    // Authoritative server time replaces the watermark instead of raising it: a wall
    // clock pushed forward once would otherwise leave lastSeen in the future forever,
    // and every later expiry check would fail closed even for a fresh download.
    lastSeenTrustedMs: serverMs,
    bootId: memory?.bootId,
    uptimeSecAtWrite: memory?.uptimeSecAtWrite,
    rebootPenaltyMs: 0,
    distrustWallClock: false,
    checkInExpiresAtMs: memory?.checkInExpiresAtMs,
    offlineRebootCount: memory?.offlineRebootCount ?? 0,
    numberOfReboot: memory?.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT
  }
  memory = next
  monoNsAtSync = process.hrtime.bigint()
  monoBaseMs = serverMs

  // Date.now() and server unixMs are both UTC epoch ms (GMT), independent of timezone.
  lastSkewMs = Math.abs(serverMs - localMs)
  clockMismatched = lastSkewMs > CLOCK_SKEW_TOLERANCE_MS
  clockChecked = true

  return next
}

/** Latest server-vs-local UTC comparison from this process (after syncTrustedTime). */
export function getClockSkewVerdict(): ClockSkewVerdict {
  return {
    mismatched: clockMismatched,
    skewMs: lastSkewMs,
    checked: clockChecked
  }
}

/** Persisted reboot-penalty overlay (0 after a successful server sync). */
export function getRebootProtectionState(): RebootProtectionState {
  return {
    penaltyMs: memory?.rebootPenaltyMs ?? 0,
    distrustWallClock: Boolean(memory?.distrustWallClock),
    bootId: memory?.bootId ?? null,
    checkInExpiresAtMs: memory?.checkInExpiresAtMs ?? null,
    offlineRebootCount: memory?.offlineRebootCount ?? 0,
    numberOfReboot: memory?.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT
  }
}

/**
 * Re-sync server GMT on a fixed interval so a clock change after launch still blocks
 * video. Failed polls keep the previous verdict (offline must not clear a mismatch).
 */
export function startTrustedTimeWatch(): void {
  stopTrustedTimeWatch()

  const tick = (): void => {
    if (skewPollInflight) {
      skewPollTimeoutId = setTimeout(tick, CLOCK_SKEW_POLL_MS)
      return
    }

    skewPollInflight = syncTrustedTime()
      .then((serverNow) => {
        const clock = getClockSkewVerdict()
        if (clock.mismatched) {
          console.warn(
            `[trusted-time] clock mismatch — |server−local|=${clock.skewMs}ms; video blocked`
          )
        } else {
          console.log('[trusted-time] re-synced', new Date(serverNow).toISOString())
        }
      })
      .catch((error) => {
        console.warn('[trusted-time] periodic sync failed; keeping last verdict', error)
      })
      .finally(() => {
        skewPollInflight = null
        if (skewPollTimeoutId !== null) {
          skewPollTimeoutId = setTimeout(tick, CLOCK_SKEW_POLL_MS)
        }
      })
  }

  // Startup already synced once; wait a full interval before the next compare.
  skewPollTimeoutId = setTimeout(tick, CLOCK_SKEW_POLL_MS)
}

export function stopTrustedTimeWatch(): void {
  if (skewPollTimeoutId !== null) {
    clearTimeout(skewPollTimeoutId)
    skewPollTimeoutId = null
  }
}

function nextCheckInExpiresAtMs(
  serverMs: number,
  previousExpiresAtMs: number | undefined
): number {
  // Keep the original 2-day deadline while it is still in the future so a
  // reconnect (including after an offline-reboot penalty) restores remaining days
  // instead of granting a fresh window.
  if (previousExpiresAtMs != null && previousExpiresAtMs > serverMs) {
    return previousExpiresAtMs
  }

  return serverMs + TRUSTED_CHECKIN_TTL_MS
}

/**
 * Fetch authoritative time from `GET /api/health/time`.
 * Updates the local offset so later offline checks do not trust the wall clock alone.
 * Clears reboot penalties and re-enables the wall clock after a successful fetch.
 */
export async function syncTrustedTime(): Promise<number> {
  await loadTrustedTime()

  const response = await net.fetch(`${API_BASE}${TIME_PATH}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-App-Key': APP_KEY
    }
  })

  if (!response.ok) {
    throw new Error(`4821 : Trusted time request failed with status ${response.status}.`)
  }

  const data = (await response.json()) as ServerTimeResponse
  const serverMs =
    typeof data.unixMs === 'number' && Number.isFinite(data.unixMs)
      ? Math.trunc(data.unixMs)
      : typeof data.iso === 'string'
        ? Date.parse(data.iso)
        : Number.NaN

  if (!Number.isFinite(serverMs)) {
    throw new Error('903 : Trusted time response is invalid.')
  }

  const previousCheckInExpires = memory?.checkInExpiresAtMs
  const localMs = Date.now()
  const state = applySync(serverMs, localMs)
  const osBootId = await readOsBootId()
  const uptime = readUptimeSec()
  memory = {
    ...state,
    bootId: nextBootId(osBootId, false, state.bootId),
    uptimeSecAtWrite: uptime,
    rebootPenaltyMs: 0,
    distrustWallClock: false,
    checkInExpiresAtMs: nextCheckInExpiresAtMs(serverMs, previousCheckInExpires),
    offlineRebootCount: 0,
    numberOfReboot: state.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT
  }
  await persist(memory)
  return serverMs
}

/**
 * If the OS rebooted since the last stamp and we have no fresh server time, add a
 * 2-day penalty, ignore the wall clock, and count the reboot toward `numberOfReboot`.
 * Idempotent for the current boot.
 */
export async function applyOfflineRebootProtection(): Promise<void> {
  if (!memory) {
    return
  }

  const osBootId = await readOsBootId()
  const uptime = readUptimeSec()
  const bootIdChanged = Boolean(memory.bootId && osBootId && memory.bootId !== osBootId)
  const reboot = bootIdChanged || isUptimeReboot(memory.uptimeSecAtWrite, uptime)

  if (!reboot) {
    if (!memory.bootId || memory.uptimeSecAtWrite == null) {
      memory = {
        ...memory,
        version: 2,
        bootId: nextBootId(osBootId, false, memory.bootId),
        uptimeSecAtWrite: uptime,
        numberOfReboot: memory.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT,
        offlineRebootCount: memory.offlineRebootCount ?? 0
      }
      await persist(memory)
    }

    if (memory.distrustWallClock) {
      beginDistrustMonoBaseline(memory.lastSeenTrustedMs)
    }

    return
  }

  const penaltyMs = (memory.rebootPenaltyMs ?? 0) + OFFLINE_REBOOT_PENALTY_MS
  const offlineRebootCount = (memory.offlineRebootCount ?? 0) + 1
  const numberOfReboot = memory.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT
  memory = {
    ...memory,
    version: 2,
    bootId: nextBootId(osBootId, true, memory.bootId),
    uptimeSecAtWrite: uptime,
    rebootPenaltyMs: penaltyMs,
    distrustWallClock: true,
    offlineRebootCount,
    numberOfReboot
  }
  beginDistrustMonoBaseline(memory.lastSeenTrustedMs)
  await persist(memory)
  console.warn(
    `[trusted-time] offline reboot ${offlineRebootCount}/${numberOfReboot}; wall clock ignored`
  )
}

/** True when offline OS reboots since last sync have reached the backend limit. */
export function isOfflineRebootLimitReached(): boolean {
  if (!memory) {
    return false
  }

  const limit = memory.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT
  const count = memory.offlineRebootCount ?? 0
  return count >= limit
}

export function parseNumberOfReboot(value: unknown): number | null {
  let raw: unknown = value
  if (typeof raw === 'string' && raw.trim() !== '') {
    raw = Number(raw)
  }

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null
  }

  const n = Math.trunc(raw)
  if (n < 1 || n > 100) {
    return null
  }

  return n
}

function numberOfRebootFromAccountLike(source: unknown): unknown {
  if (!source || typeof source !== 'object') {
    return undefined
  }

  const obj = source as Record<string, unknown>
  if (obj.numberOfReboot != null) {
    return obj.numberOfReboot
  }

  const meta = obj.metadata
  if (meta && typeof meta === 'object') {
    const record = meta as Record<string, unknown>
    if (record.numberOfReboot != null) {
      return record.numberOfReboot
    }
    if (record.number_of_reboot != null) {
      return record.number_of_reboot
    }
  }

  return undefined
}

/** Persist `numberOfReboot` from a login / account payload. */
export async function setNumberOfRebootFromAccount(account: unknown): Promise<void> {
  const parsed = parseNumberOfReboot(numberOfRebootFromAccountLike(account))
  if (parsed == null) {
    return
  }

  await loadTrustedTime()
  if (!memory) {
    return
  }

  if (memory.numberOfReboot === parsed) {
    return
  }

  memory = { ...memory, version: 2, numberOfReboot: parsed }
  await persist(memory)
}

export type TrustedNow =
  | { ok: true; nowMs: number }
  | { ok: false; reason: 'clock_rollback' | 'unsynced' }

/**
 * Best-effort trusted "now".
 * Uses server offset when available, advances at least as fast as process monotonic time
 * since the last sync (defeats a frozen wall clock while the app is running), and
 * refuses to go backwards vs the persisted watermark (defeats clock rollback).
 * After an offline reboot the wall clock is ignored and a temporary 2-day penalty is
 * added; both are cleared on the next successful server sync.
 */
export function readTrustedNow(): TrustedNow {
  if (!memory) {
    return { ok: false, reason: 'unsynced' }
  }

  const distrust = Boolean(memory.distrustWallClock)
  const wallElapsed = Date.now() - memory.localMsAtSync
  let monoElapsed = 0

  if (distrust && monoNsAtSync === null) {
    beginDistrustMonoBaseline(memory.lastSeenTrustedMs)
  }

  if (monoNsAtSync !== null) {
    monoElapsed = Number((process.hrtime.bigint() - monoNsAtSync) / 1_000_000n)
  }

  let unpenalized: number
  if (distrust) {
    // Never use Date.now() after an offline reboot — only monotonic time from lastSeen.
    unpenalized = (monoBaseMs ?? memory.lastSeenTrustedMs) + Math.max(monoElapsed, 0)
  } else {
    // Prefer the larger elapsed so freezing the wall clock cannot pause expiry in-process.
    unpenalized = memory.serverMsAtSync + Math.max(wallElapsed, monoElapsed, 0)
  }

  if (!distrust && unpenalized + 2_000 < memory.lastSeenTrustedMs) {
    // Allow 2s skew for scheduling jitter; larger backward jumps are tampering.
    return { ok: false, reason: 'clock_rollback' }
  }

  if (unpenalized > memory.lastSeenTrustedMs) {
    memory = { ...memory, lastSeenTrustedMs: unpenalized }
    void persist(memory)
  }

  const nowMs = unpenalized + (memory.rebootPenaltyMs ?? 0)
  return { ok: true, nowMs }
}

/** Trusted now in ms, or null when unsynced / rollback detected. */
export function getTrustedNowMs(): number | null {
  const result = readTrustedNow()
  return result.ok ? result.nowMs : null
}

export function getTrustedNowDate(): Date {
  const trusted = getTrustedNowMs()
  return new Date(trusted ?? Date.now())
}

/**
 * True when `expiresAt` is in the past according to trusted time.
 * Rollback or missing sync with a parseable expiry → treat as expired (fail closed).
 */
export function isTrustedExpired(expiresAt: string): boolean {
  const expiresMs = Date.parse(expiresAt)
  if (Number.isNaN(expiresMs)) {
    return true
  }

  const result = readTrustedNow()
  if (!result.ok) {
    // Fail closed: no trustworthy clock ⇒ do not keep content past its label.
    // Unsynced first run still uses wall clock so a fresh install can play until sync.
    if (result.reason === 'unsynced') {
      return Date.now() >= expiresMs
    }
    return true
  }

  return result.nowMs >= expiresMs
}

/** True when savedAt + ttl has elapsed on the trusted clock (same fail-closed rules). */
export function isTrustedTtlExpired(savedAt: string, ttlMs: number): boolean {
  const savedAtMs = Date.parse(savedAt)
  if (Number.isNaN(savedAtMs) || ttlMs < 0) {
    return true
  }

  const result = readTrustedNow()
  if (!result.ok) {
    if (result.reason === 'unsynced') {
      return Date.now() - savedAtMs > ttlMs
    }
    return true
  }

  return result.nowMs - savedAtMs > ttlMs
}

/**
 * True when the last successful server time sync is older than `ttlMs`.
 * Uses unpenalized trusted time so the 2-day window is not consumed by a reboot
 * penalty — reboot caps are checked separately via `isOfflineRebootLimitReached`.
 */
export function isTrustedCheckInExpired(ttlMs: number): boolean {
  if (ttlMs < 0 || !memory) {
    return true
  }

  const result = readTrustedNow()
  if (!result.ok) {
    return true
  }

  const unpenalized = result.nowMs - (memory.rebootPenaltyMs ?? 0)
  const deadline = memory.checkInExpiresAtMs ?? memory.serverMsAtSync + ttlMs
  return unpenalized >= deadline
}

/** Test helper — wait for queued disk writes to finish. */
export async function __flushTrustedTimePersistForTests(): Promise<void> {
  await persistQueue
}

/** Test helper — reset in-memory state between cases. */
export async function __resetTrustedTimeForTests(): Promise<void> {
  stopTrustedTimeWatch()
  await persistQueue
  await skewPollInflight
  memory = null
  loaded = false
  monoNsAtSync = null
  monoBaseMs = null
  persistQueue = Promise.resolve()
  lastSkewMs = null
  clockMismatched = false
  clockChecked = false
}

/** Test helper — inject a sync without hitting the network. */
export function __seedTrustedTimeForTests(
  serverMs: number,
  localMs = serverMs,
  lastSeenMs?: number
): void {
  loaded = true
  applySync(serverMs, localMs)
  if (memory) {
    memory = {
      ...memory,
      checkInExpiresAtMs: serverMs + TRUSTED_CHECKIN_TTL_MS,
      rebootPenaltyMs: 0,
      distrustWallClock: false,
      offlineRebootCount: 0,
      numberOfReboot: memory.numberOfReboot ?? DEFAULT_NUMBER_OF_REBOOT
    }
  }
  if (lastSeenMs !== undefined && memory) {
    memory = { ...memory, lastSeenTrustedMs: lastSeenMs }
  }
}
