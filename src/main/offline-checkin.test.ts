import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./hls-offline', () => ({
  hasOfflineVideoPackage: vi.fn(),
  deleteOfflineVideo: vi.fn()
}))

vi.mock('./hls-memory', () => ({
  clearMemoryVideo: vi.fn()
}))

vi.mock('./hls-config', () => ({
  loadHlsAppConfiguration: vi.fn(),
  getConfiguredOfflineWindowMs: vi.fn(() => 2 * 24 * 60 * 60 * 1000),
  getConfiguredVideoEndDate: vi.fn(() => null)
}))

vi.mock('./trusted-time', () => ({
  loadTrustedTime: vi.fn(),
  isTrustedCheckInExpired: vi.fn(),
  isTrustedExpired: vi.fn(),
  isOfflineRebootLimitReached: vi.fn(),
  setCheckInTtlMs: vi.fn(),
  TRUSTED_CHECKIN_TTL_MS: 2 * 24 * 60 * 60 * 1000
}))

const { hasOfflineVideoPackage, deleteOfflineVideo } = await import('./hls-offline')
const { clearMemoryVideo } = await import('./hls-memory')
const { getConfiguredOfflineWindowMs, getConfiguredVideoEndDate, loadHlsAppConfiguration } =
  await import('./hls-config')
const {
  isTrustedCheckInExpired,
  isTrustedExpired,
  isOfflineRebootLimitReached,
  loadTrustedTime
} = await import('./trusted-time')
const { isOfflineCheckInRequired, OFFLINE_CHECKIN_TTL_MS } = await import('./offline-checkin')

describe('offline-checkin', () => {
  beforeEach(() => {
    vi.mocked(hasOfflineVideoPackage).mockReset()
    vi.mocked(deleteOfflineVideo).mockReset()
    vi.mocked(deleteOfflineVideo).mockResolvedValue(undefined)
    vi.mocked(clearMemoryVideo).mockReset()
    vi.mocked(isTrustedCheckInExpired).mockReset()
    vi.mocked(isOfflineRebootLimitReached).mockReset()
    vi.mocked(isOfflineRebootLimitReached).mockReturnValue(false)
    vi.mocked(loadTrustedTime).mockReset()
    vi.mocked(loadHlsAppConfiguration).mockReset()
    vi.mocked(getConfiguredOfflineWindowMs).mockReset()
    vi.mocked(getConfiguredOfflineWindowMs).mockReturnValue(OFFLINE_CHECKIN_TTL_MS)
    vi.mocked(getConfiguredVideoEndDate).mockReset()
    vi.mocked(getConfiguredVideoEndDate).mockReturnValue(null)
    vi.mocked(isTrustedExpired).mockReset()
    vi.mocked(isTrustedExpired).mockReturnValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('defaults the check-in window to 2 days', () => {
    expect(OFFLINE_CHECKIN_TTL_MS).toBe(2 * 24 * 60 * 60 * 1000)
  })

  it('does not require internet when no offline video is on disk', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(false)

    await expect(isOfflineCheckInRequired()).resolves.toBe(false)
    expect(isTrustedCheckInExpired).not.toHaveBeenCalled()
  })

  it('requires internet when a downloaded video is older than the configured window', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(true)

    await expect(isOfflineCheckInRequired()).resolves.toBe(true)
    expect(isTrustedCheckInExpired).toHaveBeenCalledWith(OFFLINE_CHECKIN_TTL_MS)
    expect(deleteOfflineVideo).not.toHaveBeenCalled()
    expect(clearMemoryVideo).not.toHaveBeenCalled()
  })

  it('uses OFFLINE_WINDOW from app configuration for the check-in TTL', async () => {
    const fiveDays = 5 * 24 * 60 * 60 * 1000
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(getConfiguredOfflineWindowMs).mockReturnValue(fiveDays)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(false)

    await expect(isOfflineCheckInRequired()).resolves.toBe(false)
    expect(isTrustedCheckInExpired).toHaveBeenCalledWith(fiveDays)
  })

  it('allows offline login when the last sync is still within the window', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(false)

    await expect(isOfflineCheckInRequired()).resolves.toBe(false)
  })

  it('requires internet after the backend reboot cap is reached', async () => {
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(false)
    vi.mocked(isOfflineRebootLimitReached).mockReturnValue(true)

    await expect(isOfflineCheckInRequired()).resolves.toBe(true)
    expect(deleteOfflineVideo).not.toHaveBeenCalled()
    expect(clearMemoryVideo).not.toHaveBeenCalled()
  })

  it('ends the session when END_DATE has passed, even without an offline package', async () => {
    const endDate = '2026-01-07T00:00:00.000Z'
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(false)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(getConfiguredVideoEndDate).mockReturnValue(endDate)
    vi.mocked(isTrustedExpired).mockReturnValue(true)

    await expect(isOfflineCheckInRequired()).resolves.toBe(true)
    expect(isTrustedExpired).toHaveBeenCalledWith(endDate)
    expect(isTrustedCheckInExpired).not.toHaveBeenCalled()
    expect(deleteOfflineVideo).toHaveBeenCalledTimes(1)
    expect(clearMemoryVideo).toHaveBeenCalledTimes(1)
  })

  it('still ends the session if deleting the video after END_DATE fails', async () => {
    const endDate = '2026-01-07T00:00:00.000Z'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(getConfiguredVideoEndDate).mockReturnValue(endDate)
    vi.mocked(isTrustedExpired).mockReturnValue(true)
    vi.mocked(deleteOfflineVideo).mockRejectedValue(new Error('eperm'))

    await expect(isOfflineCheckInRequired()).resolves.toBe(true)
    expect(clearMemoryVideo).toHaveBeenCalledTimes(1)

    warn.mockRestore()
  })

  it('keeps the session when END_DATE is still in the future', async () => {
    const endDate = '2026-01-07T00:00:00.000Z'
    vi.mocked(hasOfflineVideoPackage).mockResolvedValue(true)
    vi.mocked(loadHlsAppConfiguration).mockResolvedValue(null)
    vi.mocked(loadTrustedTime).mockResolvedValue(undefined)
    vi.mocked(getConfiguredVideoEndDate).mockReturnValue(endDate)
    vi.mocked(isTrustedExpired).mockReturnValue(false)
    vi.mocked(isTrustedCheckInExpired).mockReturnValue(false)

    await expect(isOfflineCheckInRequired()).resolves.toBe(false)
    expect(isTrustedExpired).toHaveBeenCalledWith(endDate)
    expect(deleteOfflineVideo).not.toHaveBeenCalled()
    expect(clearMemoryVideo).not.toHaveBeenCalled()
  })
})
