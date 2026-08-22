import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAILY_ONLINE_POLL_MS } from '../../../shared/daily-online-tick'
import {
  startOfflineCheckInWatch,
  type OfflineCheckInWatchOptions
} from './offline-checkin-watch'

function startWatch(overrides: OfflineCheckInWatchOptions) {
  return startOfflineCheckInWatch({
    pollMs: DAILY_ONLINE_POLL_MS,
    ...overrides
  })
}

describe('offline-checkin-watch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 5 minutes and does not log out while END_DATE and the check-in window are still open', async () => {
    vi.useFakeTimers()
    const isRequired = vi.fn().mockResolvedValue(false)
    const onRequired = vi.fn()
    const stop = startWatch({ isRequired, onRequired })

    await vi.advanceTimersByTimeAsync(0)
    expect(isRequired).toHaveBeenCalledTimes(1)
    expect(onRequired).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS * 5)
    expect(isRequired).toHaveBeenCalledTimes(6)
    expect(onRequired).not.toHaveBeenCalled()

    stop()
  })

  it('logs out once when a later poll finds END_DATE or the check-in window expired', async () => {
    vi.useFakeTimers()
    const isRequired = vi.fn().mockResolvedValue(false)
    const onRequired = vi.fn()
    const stop = startWatch({ isRequired, onRequired })

    await vi.advanceTimersByTimeAsync(0)
    expect(onRequired).not.toHaveBeenCalled()

    isRequired.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(onRequired).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(onRequired).toHaveBeenCalledTimes(1)

    stop()
  })

  it('logs out on the first poll when the window is already expired', async () => {
    vi.useFakeTimers()
    const isRequired = vi.fn().mockResolvedValue(true)
    const onRequired = vi.fn()
    const stop = startWatch({ isRequired, onRequired })

    await vi.advanceTimersByTimeAsync(0)
    expect(onRequired).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(isRequired).toHaveBeenCalledTimes(1)
    expect(onRequired).toHaveBeenCalledTimes(1)

    stop()
  })

  it('keeps the session when a poll fails and retries on the next interval', async () => {
    vi.useFakeTimers()
    const isRequired = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce(true)
    const onRequired = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = startWatch({ isRequired, onRequired })

    await vi.advanceTimersByTimeAsync(0)
    expect(onRequired).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(onRequired).toHaveBeenCalledTimes(1)

    stop()
    warn.mockRestore()
  })
})
