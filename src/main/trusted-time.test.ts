import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

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

const { net } = await import('electron')

const {
  __flushTrustedTimePersistForTests,
  __resetTrustedTimeForTests,
  __seedTrustedTimeForTests,
  CLOCK_SKEW_TOLERANCE_MS,
  getClockSkewVerdict,
  isTrustedExpired,
  isTrustedTtlExpired,
  loadTrustedTime,
  readTrustedNow,
  syncTrustedTime
} = await import('./trusted-time')

describe('trusted-time', () => {
  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-time-'))
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
})
