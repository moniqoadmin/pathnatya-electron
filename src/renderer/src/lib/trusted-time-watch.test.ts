import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAILY_ONLINE_POLL_MS, DAILY_ONLINE_TICK_MS } from '../../../shared/daily-online-tick'
import { startTrustedTimeDailyWatch, type TrustedTimeDailyWatchOptions } from './trusted-time-watch'

function startWatch(overrides: TrustedTimeDailyWatchOptions) {
  return startTrustedTimeDailyWatch({
    pollMs: DAILY_ONLINE_POLL_MS,
    ...overrides
  })
}

describe('trusted-time-watch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('probes Cloudflare every 5 minutes but does not hit /health/time before the 24h tick is due', async () => {
    vi.useFakeTimers()
    const probeOnline = vi.fn().mockResolvedValue(true)
    const isDue = vi.fn().mockResolvedValue(false)
    const sync = vi.fn().mockResolvedValue(1)
    const stop = startWatch({ probeOnline, isDue, sync })

    await vi.advanceTimersByTimeAsync(0)
    expect(probeOnline).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS * 5)

    expect(probeOnline).toHaveBeenCalledTimes(6)
    expect(sync).not.toHaveBeenCalled()

    stop()
  })

  it('probes Cloudflare every 5 minutes while due and only syncs after it succeeds', async () => {
    vi.useFakeTimers()
    const eightPm = 1_700_000_000_000
    vi.setSystemTime(eightPm)

    const probeOnline = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const isDue = vi.fn().mockResolvedValue(true)
    const sync = vi.fn().mockImplementation(async () => {
      isDue.mockResolvedValue(false)
      return eightPm
    })
    const stop = startWatch({ probeOnline, isDue, sync })

    await vi.advanceTimersByTimeAsync(0)
    expect(probeOnline).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(probeOnline).toHaveBeenCalledTimes(2)
    expect(sync).not.toHaveBeenCalled()

    const tenPm = eightPm + 2 * 60 * 60 * 1000
    vi.setSystemTime(tenPm)
    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)

    expect(probeOnline).toHaveBeenCalledTimes(3)
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(probeOnline).toHaveBeenCalledTimes(4)
    expect(sync).toHaveBeenCalledTimes(1)

    stop()
  })

  it('syncs once immediately when reopening after the tick has already passed', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const probeOnline = vi.fn().mockResolvedValue(true)
    const isDue = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const sync = vi.fn().mockResolvedValue(now)
    const stop = startWatch({ probeOnline, isDue, sync })

    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(probeOnline).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(probeOnline).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(1)

    stop()
  })

  it('keeps the window due when Cloudflare is up but the sync fails', async () => {
    vi.useFakeTimers()
    const probeOnline = vi.fn().mockResolvedValue(true)
    const isDue = vi.fn().mockResolvedValue(true)
    const sync = vi.fn().mockRejectedValue(new Error('timeout'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = startWatch({ probeOnline, isDue, sync })

    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DAILY_ONLINE_POLL_MS)
    expect(probeOnline).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(2)

    stop()
    warn.mockRestore()
  })

  it('uses the same 24h window as the play-log Cloudflare tick', () => {
    expect(DAILY_ONLINE_TICK_MS).toBe(24 * 60 * 60 * 1000)
    expect(DAILY_ONLINE_POLL_MS).toBe(5 * 60 * 1000)
  })
})
