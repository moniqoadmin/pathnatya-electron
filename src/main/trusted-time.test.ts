import { mkdtemp, rm } from 'fs/promises'
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
  }
}))

const { net } = await import('electron')

const {
  __resetTrustedTimeForTests,
  __seedTrustedTimeForTests,
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
    const serverMs = 1_700_000_000_000
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

  it('persists sync and reloads last-seen watermark', async () => {
    const serverMs = 1_800_000_000_000
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ iso: new Date(serverMs).toISOString(), unixMs: serverMs })
    } as Response)

    await syncTrustedTime()
    const before = readTrustedNow()
    expect(before.ok).toBe(true)

    await __resetTrustedTimeForTests()
    await loadTrustedTime()
    const after = readTrustedNow()
    expect(after.ok).toBe(true)
    if (before.ok && after.ok) {
      expect(after.nowMs).toBeGreaterThanOrEqual(before.nowMs - 2_000)
    }
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
