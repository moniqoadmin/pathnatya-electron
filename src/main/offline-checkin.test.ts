import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./hls-offline', () => ({
  hasOfflineVideoPackage: vi.fn()
}))

vi.mock('./trusted-time', () => ({
  loadTrustedTime: vi.fn(),
  syncTrustedTime: vi.fn(),
  isTrustedCheckInExpired: vi.fn(),
  isOfflineRebootLimitReached: vi.fn(),
  TRUSTED_CHECKIN_TTL_MS: 2 * 24 * 60 * 60 * 1000
}))

const { hasOfflineVideoPackage } = await import('./hls-offline')
const { isTrustedCheckInExpired, isOfflineRebootLimitReached, loadTrustedTime, syncTrustedTime } =
  await import('./trusted-time')
const { isOfflineCheckInRequired, renewOfflineCheckIn, OFFLINE_CHECKIN_TTL_MS } =
  await import('./offline-checkin')

describe('offline-checkin', () => {
  beforeEach(() => {
    vi.mocked(hasOfflineVideoPackage).mockReset()
    vi.mocked(isTrustedCheckInExpired).mockReset()
    vi.mocked(isOfflineRebootLimitReached).mockReset()
    vi.mocked(isOfflineRebootLimitReached).mockReturnValue(false)
    vi.mocked(loadTrustedTime).mockReset()
    vi.mocked(syncTrustedTime).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses a 2-day check-in window', () => {
    expect(OFFLINE_CHECKIN_TTL_MS).toBe(2 * 24 * 60 * 60 * 1000)
  })

  it('does not require internet when no offline video is on disk', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(false)

    await expect(isOfflineCheckInRequired()).resolves.toBe(false)
    expect(isTrustedCheckInExpired).not.toHaveBeenCalled()
  })

  it('requires internet when a downloaded video is older than two days since last sync', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(true)

    await expect(isOfflineCheckInRequired()).resolves.toBe(true)
    expect(isTrustedCheckInExpired).toHaveBeenCalledWith(OFFLINE_CHECKIN_TTL_MS)
  })

  it('allows offline login when the last sync is still within two days', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(false)

    await expect(isOfflineCheckInRequired()).resolves.toBe(false)
  })

  it('requires internet after the backend reboot cap is reached', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(false)
    vi.mocked(isOfflineRebootLimitReached).mockReturnValue(true)

    await expect(isOfflineCheckInRequired()).resolves.toBe(true)
  })

  it('renews the window from a successful server time sync', async () => {
    vi.mocked(syncTrustedTime).mockResolvedValue(1_700_000_000_000)

    await expect(renewOfflineCheckIn()).resolves.toBe(true)
    expect(syncTrustedTime).toHaveBeenCalledOnce()
  })

  it('leaves the window unchanged when the renew sync fails', async () => {
    vi.mocked(syncTrustedTime).mockRejectedValue(new Error('offline'))

    await expect(renewOfflineCheckIn()).resolves.toBe(false)
  })
})
