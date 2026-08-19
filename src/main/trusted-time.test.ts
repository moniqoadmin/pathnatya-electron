import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

const bootMocks = vi.hoisted(() => ({
  osBootId: 'boot-1' as string | null,
  uptimeSec: 10_000
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  },
  net: {
    fetch: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (payload: Buffer) => {
      const text = payload.toString('utf8')
      if (!text.startsWith('sealed:')) {
        throw new Error('decrypt failed')
      }
      return text.slice('sealed:'.length)
    }
  }
}))

vi.mock('./boot-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./boot-id')>()
  return {
    ...actual,
    readOsBootId: vi.fn(async () => bootMocks.osBootId),
    readUptimeSec: vi.fn(() => bootMocks.uptimeSec)
  }
})

const { net } = await import('electron')

const {
  __flushTrustedTimePersistForTests,
  __resetTrustedTimeForTests,
  __seedTrustedTimeForTests,
  CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_NUMBER_OF_REBOOT,
  FULLSCREEN_TIME_SYNC_EVERY_CLICKS,
  OFFLINE_REBOOT_PENALTY_MS,
  TRUSTED_CHECKIN_TTL_MS,
  applyOfflineRebootProtection,
  getClockSkewVerdict,
  getRebootProtectionState,
  isOfflineRebootLimitReached,
  isTrustedExpired,
  isTrustedTtlExpired,
  isTrustedCheckInExpired,
  loadTrustedTime,
  readTrustedNow,
  setNumberOfRebootFromAccount,
  syncTrustedTime,
  syncTrustedTimeOnFullscreenClick,
  syncTrustedTimeOnLogin
} = await import('./trusted-time')

function mockServerTime(serverMs: number): void {
  vi.mocked(net.fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      iso: new Date(serverMs).toISOString(),
      unixMs: serverMs
    })
  } as Response)
}

describe('trusted-time', () => {
  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-time-'))
    bootMocks.osBootId = 'boot-1'
    bootMocks.uptimeSec = 10_000
    await __resetTrustedTimeForTests()
    vi.mocked(net.fetch).mockReset()
  })

  afterEach(async () => {
    await __resetTrustedTimeForTests()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('syncs from /health/time and stamps expiry from server clock', async () => {
    const serverMs = Date.now()
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        iso: new Date(serverMs).toISOString(),
        unixMs: serverMs
      })
    } as Response)

    const synced = await syncTrustedTime()
    expect(synced).toBe(serverMs)

    const now = readTrustedNow()
    expect(now.ok).toBe(true)
    if (now.ok) {
      expect(now.nowMs).toBeGreaterThanOrEqual(serverMs)
      expect(now.nowMs).toBeLessThan(serverMs + 60_000)
    }

    expect(isTrustedExpired(new Date(serverMs + 10 * 24 * 60 * 60 * 1000).toISOString())).toBe(
      false
    )
    expect(isTrustedExpired(new Date(serverMs - 1_000).toISOString())).toBe(true)
  })

  it('flags GMT mismatch when local clock differs beyond tolerance', async () => {
    const serverMs = Date.now()
    const skew = CLOCK_SKEW_TOLERANCE_MS + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(serverMs + skew)
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ iso: new Date(serverMs).toISOString(), unixMs: serverMs })
    } as Response)

    await syncTrustedTime()
    const verdict = getClockSkewVerdict()
    expect(verdict.checked).toBe(true)
    expect(verdict.mismatched).toBe(true)
    expect(verdict.skewMs).toBe(skew)

    vi.restoreAllMocks()
  })

  it('allows video when server and local GMT are within tolerance', async () => {
    const serverMs = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(serverMs + Math.floor(CLOCK_SKEW_TOLERANCE_MS / 2))
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ iso: new Date(serverMs).toISOString(), unixMs: serverMs })
    } as Response)

    await syncTrustedTime()
    const verdict = getClockSkewVerdict()
    expect(verdict.checked).toBe(true)
    expect(verdict.mismatched).toBe(false)

    vi.restoreAllMocks()
  })

  it('persists sync sealed and reloads last-seen watermark', async () => {
    const serverMs = Date.now()
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ iso: new Date(serverMs).toISOString(), unixMs: serverMs })
    } as Response)

    await syncTrustedTime()
    const before = readTrustedNow()
    expect(before.ok).toBe(true)
    await __flushTrustedTimePersistForTests()

    const onDisk = await readFile(join(userDataDir, 'trusted-time.dat'))
    expect(onDisk.toString('utf8')).toMatch(/^sealed:/)
    expect(() => JSON.parse(onDisk.toString('utf8'))).toThrow()

    await __resetTrustedTimeForTests()
    await loadTrustedTime()
    const after = readTrustedNow()
    expect(after.ok).toBe(true)
    if (before.ok && after.ok) {
      expect(after.nowMs).toBeGreaterThanOrEqual(before.nowMs - 2_000)
    }
  })

  it('migrates legacy plaintext trusted-time.json into sealed .dat', async () => {
    const serverMs = Date.now() - 60_000
    await writeFile(
      join(userDataDir, 'trusted-time.json'),
      JSON.stringify({
        version: 1,
        serverMsAtSync: serverMs,
        localMsAtSync: serverMs,
        lastSeenTrustedMs: serverMs
      }),
      'utf8'
    )

    await loadTrustedTime()
    const now = readTrustedNow()
    expect(now.ok).toBe(true)
    await __flushTrustedTimePersistForTests()

    const sealed = await readFile(join(userDataDir, 'trusted-time.dat'))
    expect(sealed.toString('utf8')).toMatch(/^sealed:/)
    expect(() => JSON.parse(sealed.toString('utf8'))).toThrow()

    await expect(readFile(join(userDataDir, 'trusted-time.json'))).rejects.toThrow()
  })

  it('ignores a tampered sealed file', async () => {
    await writeFile(join(userDataDir, 'trusted-time.dat'), Buffer.from('not-sealed-garbage'))
    await loadTrustedTime()
    expect(readTrustedNow()).toEqual({ ok: false, reason: 'unsynced' })
  })

  it('treats TTL expiry from trusted time', () => {
    const serverMs = 1_700_000_000_000
    __seedTrustedTimeForTests(serverMs, Date.now())

    const tenDays = 10 * 24 * 60 * 60 * 1000
    expect(isTrustedTtlExpired(new Date(serverMs).toISOString(), tenDays)).toBe(false)
    expect(isTrustedTtlExpired(new Date(serverMs - tenDays - 1_000).toISOString(), tenDays)).toBe(
      true
    )
  })

  it('treats a 2-day check-in as expired from last server sync', () => {
    const serverMs = 1_700_000_000_000
    const twoDays = 2 * 24 * 60 * 60 * 1000
    __seedTrustedTimeForTests(serverMs, Date.now())

    expect(isTrustedCheckInExpired(twoDays)).toBe(false)

    // Wall clock has advanced 2 days since the last sync.
    __seedTrustedTimeForTests(serverMs, Date.now() - twoDays)
    expect(isTrustedCheckInExpired(twoDays)).toBe(true)
  })

  it('fails closed on unsynced or rolled-back clocks for check-in', () => {
    const twoDays = 2 * 24 * 60 * 60 * 1000
    expect(isTrustedCheckInExpired(twoDays)).toBe(true)

    const serverMs = 1_700_000_000_000
    const fiveDays = 5 * 24 * 60 * 60 * 1000
    __seedTrustedTimeForTests(
      serverMs,
      Date.now() + 90 * 24 * 60 * 60 * 1000,
      serverMs + fiveDays
    )
    expect(isTrustedCheckInExpired(twoDays)).toBe(true)
  })

  it('fails closed on clock rollback for expiry checks', () => {
    const serverMs = 1_700_000_000_000
    const fiveDays = 5 * 24 * 60 * 60 * 1000
    // Local clock far ahead of reality ⇒ wallElapsed deeply negative vs lastSeen.
    __seedTrustedTimeForTests(serverMs, Date.now() + 90 * 24 * 60 * 60 * 1000, serverMs + fiveDays)

    const rolled = readTrustedNow()
    expect(rolled.ok).toBe(false)
    if (!rolled.ok) {
      expect(rolled.reason).toBe('clock_rollback')
    }

    expect(isTrustedExpired(new Date(serverMs + 365 * 24 * 60 * 60 * 1000).toISOString())).toBe(
      true
    )
  })

  it('heals a future watermark on server sync so a fresh package is not expired', async () => {
    const serverMs = 1_700_000_000_000
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    const tenDays = 10 * 24 * 60 * 60 * 1000

    // Wall clock pushed 30 days forward while running, raising the persisted watermark.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(serverMs)
    __seedTrustedTimeForTests(serverMs, serverMs)
    nowSpy.mockReturnValue(serverMs + thirtyDays)
    expect(readTrustedNow().ok).toBe(true)
    await __flushTrustedTimePersistForTests()

    // Clock corrected, then a download syncs server time and stamps expiry 10 days out.
    nowSpy.mockReturnValue(serverMs)
    mockServerTime(serverMs)
    const syncedMs = await syncTrustedTime()

    expect(readTrustedNow()).toEqual({ ok: true, nowMs: expect.any(Number) })
    expect(isTrustedExpired(new Date(syncedMs + tenDays).toISOString())).toBe(false)
  })

  it('does not penalize a same-boot reload', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    await loadTrustedTime()

    const protection = getRebootProtectionState()
    expect(protection.penaltyMs).toBe(0)
    expect(protection.distrustWallClock).toBe(false)
    expect(protection.bootId).toBe('boot-1')
  })

  it('applies a 2-day penalty and ignores the wall clock after an offline reboot', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    vi.spyOn(Date, 'now').mockReturnValue(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    const before = readTrustedNow()
    expect(before.ok).toBe(true)

    await __resetTrustedTimeForTests()
    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 12
    await loadTrustedTime()

    const protection = getRebootProtectionState()
    expect(protection.penaltyMs).toBe(OFFLINE_REBOOT_PENALTY_MS)
    expect(protection.distrustWallClock).toBe(true)
    expect(protection.bootId).toBe('boot-2')
    expect(protection.checkInExpiresAtMs).toBe(serverMs + TRUSTED_CHECKIN_TTL_MS)
    expect(protection.offlineRebootCount).toBe(1)
    expect(protection.numberOfReboot).toBe(DEFAULT_NUMBER_OF_REBOOT)
    expect(isOfflineRebootLimitReached()).toBe(false)

    // Wall clock jumped far ahead — must not extend trusted time.
    vi.spyOn(Date, 'now').mockReturnValue(serverMs + 90 * 24 * 60 * 60 * 1000)
    const penalized = readTrustedNow()
    expect(penalized.ok).toBe(true)
    if (before.ok && penalized.ok) {
      expect(penalized.nowMs).toBeGreaterThanOrEqual(before.nowMs + OFFLINE_REBOOT_PENALTY_MS)
      expect(penalized.nowMs).toBeLessThan(before.nowMs + OFFLINE_REBOOT_PENALTY_MS + 60_000)
    }

    expect(isTrustedCheckInExpired(TRUSTED_CHECKIN_TTL_MS)).toBe(false)
    vi.restoreAllMocks()
  })

  it('does not restack the penalty on another launch of the same boot', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 12
    await loadTrustedTime()
    expect(getRebootProtectionState().penaltyMs).toBe(OFFLINE_REBOOT_PENALTY_MS)
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    bootMocks.uptimeSec = 40
    await loadTrustedTime()
    expect(getRebootProtectionState().penaltyMs).toBe(OFFLINE_REBOOT_PENALTY_MS)
    expect(getRebootProtectionState().bootId).toBe('boot-2')
    expect(getRebootProtectionState().offlineRebootCount).toBe(1)
  })

  it('stacks a 2-day penalty for each offline reboot', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 8
    await loadTrustedTime()
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    bootMocks.osBootId = 'boot-3'
    bootMocks.uptimeSec = 4
    await loadTrustedTime()

    expect(getRebootProtectionState().penaltyMs).toBe(2 * OFFLINE_REBOOT_PENALTY_MS)
    expect(getRebootProtectionState().offlineRebootCount).toBe(2)
    expect(isOfflineRebootLimitReached()).toBe(false)
  })

  it('detects reboot from uptime regression when the OS has no boot id', async () => {
    bootMocks.osBootId = null
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    bootMocks.uptimeSec = 3
    await loadTrustedTime()

    expect(getRebootProtectionState().penaltyMs).toBe(OFFLINE_REBOOT_PENALTY_MS)
    expect(getRebootProtectionState().distrustWallClock).toBe(true)
  })

  it('clears penalties on reconnect, keeps the original 2-day expiry, and restores remaining days', async () => {
    const serverMs = 1_700_000_000_000
    const oneDay = 24 * 60 * 60 * 1000
    const tenDays = 10 * 24 * 60 * 60 * 1000
    mockServerTime(serverMs)
    vi.spyOn(Date, 'now').mockReturnValue(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    const originalCheckIn = getRebootProtectionState().checkInExpiresAtMs
    expect(originalCheckIn).toBe(serverMs + TRUSTED_CHECKIN_TTL_MS)

    await __resetTrustedTimeForTests()
    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 15
    await loadTrustedTime()
    expect(isTrustedCheckInExpired(TRUSTED_CHECKIN_TTL_MS)).toBe(false)
    expect(isOfflineRebootLimitReached()).toBe(false)
    expect(isTrustedExpired(new Date(serverMs + tenDays).toISOString())).toBe(false)

    const reconnectMs = serverMs + oneDay
    mockServerTime(reconnectMs)
    vi.spyOn(Date, 'now').mockReturnValue(reconnectMs)
    await syncTrustedTime()

    const restored = getRebootProtectionState()
    expect(restored.penaltyMs).toBe(0)
    expect(restored.distrustWallClock).toBe(false)
    expect(restored.checkInExpiresAtMs).toBe(originalCheckIn)
    expect(restored.offlineRebootCount).toBe(0)

    const now = readTrustedNow()
    expect(now.ok).toBe(true)
    if (now.ok) {
      expect(now.nowMs).toBeGreaterThanOrEqual(reconnectMs)
      expect(now.nowMs).toBeLessThan(reconnectMs + 60_000)
    }

    expect(isTrustedCheckInExpired(TRUSTED_CHECKIN_TTL_MS)).toBe(false)
    expect(isTrustedExpired(new Date(serverMs + tenDays).toISOString())).toBe(false)
    expect(isTrustedExpired(new Date(reconnectMs + oneDay).toISOString())).toBe(false)
    vi.restoreAllMocks()
  })

  it('does not apply a penalty when the reboot can sync with the server', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await __flushTrustedTimePersistForTests()

    await __resetTrustedTimeForTests()
    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 6
    mockServerTime(serverMs + 3_600_000)
    await syncTrustedTime()

    const protection = getRebootProtectionState()
    expect(protection.penaltyMs).toBe(0)
    expect(protection.distrustWallClock).toBe(false)
    expect(protection.bootId).toBe('boot-2')
  })

  it('applyOfflineRebootProtection is idempotent for the current boot', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()

    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 9
    await applyOfflineRebootProtection()
    await applyOfflineRebootProtection()

    expect(getRebootProtectionState().penaltyMs).toBe(OFFLINE_REBOOT_PENALTY_MS)
  })

  it('requires internet after numberOfReboot offline reboots from the backend', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await setNumberOfRebootFromAccount({ numberOfReboot: 3 })
    await __flushTrustedTimePersistForTests()
    expect(getRebootProtectionState().numberOfReboot).toBe(3)

    for (const boot of ['boot-2', 'boot-3', 'boot-4']) {
      await __resetTrustedTimeForTests()
      bootMocks.osBootId = boot
      bootMocks.uptimeSec = 5
      await loadTrustedTime()
      await __flushTrustedTimePersistForTests()
    }

    expect(getRebootProtectionState().offlineRebootCount).toBe(3)
    expect(isOfflineRebootLimitReached()).toBe(true)
    expect(isTrustedCheckInExpired(TRUSTED_CHECKIN_TTL_MS)).toBe(false)
  })

  it('reads numberOfReboot from account metadata and resets the count on reconnect', async () => {
    const serverMs = 1_700_000_000_000
    mockServerTime(serverMs)
    await syncTrustedTime()
    await setNumberOfRebootFromAccount({ metadata: { numberOfReboot: 1 } })

    bootMocks.osBootId = 'boot-2'
    bootMocks.uptimeSec = 7
    await applyOfflineRebootProtection()
    expect(isOfflineRebootLimitReached()).toBe(true)

    mockServerTime(serverMs + 60_000)
    await syncTrustedTime()
    expect(getRebootProtectionState().offlineRebootCount).toBe(0)
    expect(getRebootProtectionState().numberOfReboot).toBe(1)
    expect(isOfflineRebootLimitReached()).toBe(false)
  })

  it('syncs on login and only every 5th fullscreen click', async () => {
    const serverMs = Date.now()
    mockServerTime(serverMs)

    await expect(syncTrustedTimeOnLogin()).resolves.toBe(serverMs)
    expect(net.fetch).toHaveBeenCalledTimes(1)

    mockServerTime(serverMs + 1_000)
    for (let click = 1; click < FULLSCREEN_TIME_SYNC_EVERY_CLICKS; click += 1) {
      await expect(syncTrustedTimeOnFullscreenClick()).resolves.toBeNull()
    }
    expect(net.fetch).toHaveBeenCalledTimes(1)

    await expect(syncTrustedTimeOnFullscreenClick()).resolves.toBe(serverMs + 1_000)
    expect(net.fetch).toHaveBeenCalledTimes(2)

    mockServerTime(serverMs + 2_000)
    for (let click = 1; click < FULLSCREEN_TIME_SYNC_EVERY_CLICKS; click += 1) {
      await expect(syncTrustedTimeOnFullscreenClick()).resolves.toBeNull()
    }
    await expect(syncTrustedTimeOnFullscreenClick()).resolves.toBe(serverMs + 2_000)
    expect(net.fetch).toHaveBeenCalledTimes(3)

    mockServerTime(serverMs + 3_000)
    for (let click = 1; click < FULLSCREEN_TIME_SYNC_EVERY_CLICKS; click += 1) {
      await expect(syncTrustedTimeOnFullscreenClick()).resolves.toBeNull()
    }
    expect(net.fetch).toHaveBeenCalledTimes(3)

    await expect(syncTrustedTimeOnLogin()).resolves.toBe(serverMs + 3_000)
    expect(net.fetch).toHaveBeenCalledTimes(4)

    mockServerTime(serverMs + 4_000)
    await expect(syncTrustedTimeOnFullscreenClick()).resolves.toBeNull()
    expect(net.fetch).toHaveBeenCalledTimes(4)
  })
})
