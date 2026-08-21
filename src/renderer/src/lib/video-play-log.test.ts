import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createVideoPlayLogController,
  VIDEO_PLAY_LOG_INTERVAL_MS,
  VIDEO_PLAY_LOG_POLL_MS,
  type PostVideoPlayLog,
  type ProbeOnline,
  type VideoPlayLogCounts,
  type VideoPlayLogStore
} from './video-play-log'

function memoryStore(initial?: VideoPlayLogCounts): VideoPlayLogStore {
  let counts: VideoPlayLogCounts = initial ?? { windowCount: 0, offlineCount: 0 }
  return {
    read: () => ({ ...counts }),
    write: (next) => {
      counts = { ...next }
    }
  }
}

function posted(
  postLog: ReturnType<typeof vi.fn<PostVideoPlayLog>>
): Array<{ event: string; fullscreenClicks: number }> {
  return postLog.mock.calls.map(([event, , , options]) => ({
    event,
    fullscreenClicks: Number(options?.metadata?.fullscreenClicks)
  }))
}

function onlineProbe(): ProbeOnline {
  return vi.fn<ProbeOnline>().mockResolvedValue(true)
}

function controller(store?: VideoPlayLogStore, probeOnline: ProbeOnline = onlineProbe()) {
  return {
    logger: createVideoPlayLogController(store ?? memoryStore(), { probeOnline }),
    probeOnline
  }
}

describe('video-play-log', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts each fullscreen enter in the current window', () => {
    const { logger } = controller()
    logger.recordFullscreen()
    logger.recordFullscreen()
    expect(logger.getCounts()).toEqual({ windowCount: 2, offlineCount: 0 })
  })

  it('posts VIDEO_PLAY with the window count and clears it', async () => {
    const { logger } = controller()
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    logger.recordFullscreen()
    logger.recordFullscreen()
    logger.recordFullscreen()

    await logger.flush(postLog)

    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 3 }])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 0 })
  })

  it('moves the window count offline when the log API fails', async () => {
    const { logger } = controller()
    const postLog = vi.fn<PostVideoPlayLog>().mockRejectedValue(new Error('network'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.recordFullscreen()
    logger.recordFullscreen()

    await logger.flush(postLog)
    errorSpy.mockRestore()

    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 2 }])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 2 })
  })

  it('sends VIDEO_PLAY_OFFLINE once a later flush reaches the API', async () => {
    const { logger } = controller(memoryStore({ windowCount: 0, offlineCount: 4 }))
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    logger.recordFullscreen()
    logger.recordFullscreen()

    await logger.flush(postLog)

    expect(posted(postLog)).toEqual([
      { event: 'VIDEO_PLAY', fullscreenClicks: 2 },
      { event: 'VIDEO_PLAY_OFFLINE', fullscreenClicks: 4 }
    ])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 0 })
  })

  it('keeps adding failed windows to the offline bucket', async () => {
    const { logger } = controller(memoryStore({ windowCount: 0, offlineCount: 4 }))
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(false)
    logger.recordFullscreen()

    await logger.flush(postLog)

    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 1 }])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 5 })
  })

  it('retries VIDEO_PLAY_OFFLINE when that call fails after an online VIDEO_PLAY', async () => {
    const { logger } = controller(memoryStore({ windowCount: 0, offlineCount: 3 }))
    const postLog = vi.fn<PostVideoPlayLog>().mockImplementation(async (event) => {
      return event === 'VIDEO_PLAY'
    })
    logger.recordFullscreen()

    await logger.flush(postLog)

    expect(posted(postLog)).toEqual([
      { event: 'VIDEO_PLAY', fullscreenClicks: 1 },
      { event: 'VIDEO_PLAY_OFFLINE', fullscreenClicks: 3 }
    ])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 3 })
  })

  it('does not call the API when there is nothing to report', async () => {
    const { logger } = controller()
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)

    await logger.flush(postLog)

    expect(postLog).not.toHaveBeenCalled()
  })

  it('ignores an overlapping flush so counts are not double-sent', async () => {
    const { logger } = controller()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const postLog = vi.fn<PostVideoPlayLog>().mockImplementation(async () => {
      await gate
      return true
    })
    logger.recordFullscreen()

    const first = logger.flush(postLog)
    const second = logger.flush(postLog)
    release()
    await Promise.all([first, second])

    expect(postLog).toHaveBeenCalledTimes(1)
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 0 })
  })

  it('probes Cloudflare every 5 minutes but does not post logs before the 24h tick is due', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const probeOnline = vi.fn<ProbeOnline>().mockResolvedValue(true)
    const { logger } = controller(
      memoryStore({ windowCount: 2, offlineCount: 0, lastFlushAt: now }),
      probeOnline
    )
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    const stop = logger.start(postLog, VIDEO_PLAY_LOG_POLL_MS)

    await vi.advanceTimersByTimeAsync(0)
    expect(probeOnline).toHaveBeenCalledTimes(1)
    expect(postLog).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(VIDEO_PLAY_LOG_POLL_MS * 5)

    expect(probeOnline).toHaveBeenCalledTimes(6)
    expect(postLog).not.toHaveBeenCalled()

    stop()
  })

  it('probes Cloudflare every 5 minutes while due and only posts after it succeeds', async () => {
    vi.useFakeTimers()
    const eightPm = 1_700_000_000_000
    vi.setSystemTime(eightPm)

    const probeOnline = vi
      .fn<ProbeOnline>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { logger } = controller(
      memoryStore({
        windowCount: 2,
        offlineCount: 0,
        lastFlushAt: eightPm - VIDEO_PLAY_LOG_INTERVAL_MS
      }),
      probeOnline
    )
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    const stop = logger.start(postLog, VIDEO_PLAY_LOG_POLL_MS)

    await vi.advanceTimersByTimeAsync(0)
    expect(probeOnline).toHaveBeenCalledTimes(1)
    expect(postLog).not.toHaveBeenCalled()
    expect(logger.getCounts().lastFlushAt).toBe(eightPm - VIDEO_PLAY_LOG_INTERVAL_MS)

    await vi.advanceTimersByTimeAsync(VIDEO_PLAY_LOG_POLL_MS)
    expect(probeOnline).toHaveBeenCalledTimes(2)
    expect(postLog).not.toHaveBeenCalled()

    const tenPm = eightPm + 2 * 60 * 60 * 1000
    vi.setSystemTime(tenPm)
    await vi.advanceTimersByTimeAsync(VIDEO_PLAY_LOG_POLL_MS)

    expect(probeOnline).toHaveBeenCalledTimes(3)
    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 2 }])
    expect(logger.getCounts()).toEqual({
      windowCount: 0,
      offlineCount: 0,
      lastFlushAt: Date.now()
    })

    await vi.advanceTimersByTimeAsync(VIDEO_PLAY_LOG_POLL_MS)
    expect(probeOnline).toHaveBeenCalledTimes(4)
    expect(postLog).toHaveBeenCalledTimes(1)

    stop()
  })

  it('posts once immediately when reopening after the tick has already passed', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const probeOnline = vi.fn<ProbeOnline>().mockResolvedValue(true)
    const { logger } = controller(
      memoryStore({
        windowCount: 1,
        offlineCount: 0,
        lastFlushAt: now - VIDEO_PLAY_LOG_INTERVAL_MS
      }),
      probeOnline
    )
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    const stop = logger.start(postLog, VIDEO_PLAY_LOG_POLL_MS)

    await vi.advanceTimersByTimeAsync(0)
    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 1 }])
    expect(logger.getCounts().lastFlushAt).toBe(now)

    stop()
  })

  it('rolls an empty due window to tomorrow without calling /logs', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const probeOnline = vi.fn<ProbeOnline>().mockResolvedValue(true)
    const { logger } = controller(
      memoryStore({
        windowCount: 0,
        offlineCount: 0,
        lastFlushAt: now - VIDEO_PLAY_LOG_INTERVAL_MS
      }),
      probeOnline
    )
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    const stop = logger.start(postLog, VIDEO_PLAY_LOG_POLL_MS)

    await vi.advanceTimersByTimeAsync(0)
    expect(probeOnline).toHaveBeenCalledTimes(1)
    expect(postLog).not.toHaveBeenCalled()
    expect(logger.getCounts().lastFlushAt).toBe(now)

    stop()
  })
})
