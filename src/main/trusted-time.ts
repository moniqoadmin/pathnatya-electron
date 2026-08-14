import { promises as fs } from 'fs'
import { join } from 'path'
import { app, net } from 'electron'
import { APP_KEY, API_BASE } from '../shared/api-config'

const STATE_FILE = 'trusted-time.json'
const TIME_PATH = '/health/time'

interface TrustedTimeState {
  version: 1
  /** Server unix ms at last successful sync. */
  serverMsAtSync: number
  /** Local Date.now() at that sync. */
  localMsAtSync: number
  /** Highest trusted "now" observed — used to detect clock rollback. */
  lastSeenTrustedMs: number
}

interface ServerTimeResponse {
  iso?: string
  unixMs?: number
}

let memory: TrustedTimeState | null = null
let loaded = false
/** Monotonic baseline taken at the latest sync (process-local). */
let monoNsAtSync: bigint | null = null
let persistQueue: Promise<void> = Promise.resolve()

function statePath(): string {
  return join(app.getPath('userData'), STATE_FILE)
}

function isValidState(value: unknown): value is TrustedTimeState {
  if (!value || typeof value !== 'object') {
    return false
  }

  const parsed = value as TrustedTimeState
  return (
    parsed.version === 1 &&
    Number.isFinite(parsed.serverMsAtSync) &&
    Number.isFinite(parsed.localMsAtSync) &&
    Number.isFinite(parsed.lastSeenTrustedMs)
  )
}

async function persist(state: TrustedTimeState): Promise<void> {
  persistQueue = persistQueue
    .then(async () => {
      await fs.writeFile(statePath(), JSON.stringify(state), 'utf8')
    })
    .catch(() => {
      // Best-effort — expiry still works in-memory for this process.
    })
  await persistQueue
}

/**
 * Load persisted offset / last-seen watermark. Safe to call repeatedly.
 */
export async function loadTrustedTime(): Promise<void> {
  if (loaded) {
    return
  }

  loaded = true
  try {
    const raw = await fs.readFile(statePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isValidState(parsed)) {
      memory = parsed
    }
  } catch {
    memory = null
  }
}

function applySync(serverMs: number, localMs: number): TrustedTimeState {
  const previousSeen = memory?.lastSeenTrustedMs ?? 0
  const next: TrustedTimeState = {
    version: 1,
    serverMsAtSync: serverMs,
    localMsAtSync: localMs,
    lastSeenTrustedMs: Math.max(previousSeen, serverMs)
  }
  memory = next
  monoNsAtSync = process.hrtime.bigint()
  return next
}

/**
 * Fetch authoritative time from `GET /api/health/time`.
 * Updates the local offset so later offline checks do not trust the wall clock alone.
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

  const localMs = Date.now()
  const state = applySync(serverMs, localMs)
  await persist(state)
  return serverMs
}

export type TrustedNow =
  | { ok: true; nowMs: number }
  | { ok: false; reason: 'clock_rollback' | 'unsynced' }

/**
 * Best-effort trusted "now".
 * Uses server offset when available, advances at least as fast as process monotonic time
 * since the last sync (defeats a frozen wall clock while the app is running), and
 * refuses to go backwards vs the persisted watermark (defeats clock rollback).
 */
export function readTrustedNow(): TrustedNow {
  if (!memory) {
    return { ok: false, reason: 'unsynced' }
  }

  const wallElapsed = Date.now() - memory.localMsAtSync
  let monoElapsed = 0
  if (monoNsAtSync !== null) {
    monoElapsed = Number((process.hrtime.bigint() - monoNsAtSync) / 1_000_000n)
  }

  // Prefer the larger elapsed so freezing the wall clock cannot pause expiry in-process.
  const elapsed = Math.max(wallElapsed, monoElapsed, 0)
  const nowMs = memory.serverMsAtSync + elapsed

  if (nowMs + 2_000 < memory.lastSeenTrustedMs) {
    // Allow 2s skew for scheduling jitter; larger backward jumps are tampering.
    return { ok: false, reason: 'clock_rollback' }
  }

  if (nowMs > memory.lastSeenTrustedMs) {
    memory = { ...memory, lastSeenTrustedMs: nowMs }
    void persist(memory)
  }

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

/** Test helper — reset in-memory state between cases. */
export async function __resetTrustedTimeForTests(): Promise<void> {
  await persistQueue
  memory = null
  loaded = false
  monoNsAtSync = null
  persistQueue = Promise.resolve()
}

/** Test helper — inject a sync without hitting the network. */
export function __seedTrustedTimeForTests(
  serverMs: number,
  localMs = serverMs,
  lastSeenMs?: number
): void {
  loaded = true
  memory = {
    version: 1,
    serverMsAtSync: serverMs,
    localMsAtSync: localMs,
    lastSeenTrustedMs: lastSeenMs ?? Math.max(memory?.lastSeenTrustedMs ?? 0, serverMs)
  }
  monoNsAtSync = process.hrtime.bigint()
}
