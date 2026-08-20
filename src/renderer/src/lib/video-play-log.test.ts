import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createVideoPlayLogController,
  VIDEO_PLAY_LOG_INTERVAL_MS,
  type PostVideoPlayLog,
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

describe('video-play-log', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts each fullscreen enter in the current window', () => {
    const logger = createVideoPlayLogController(memoryStore())
    logger.recordFullscreen()
    logger.recordFullscreen()
    expect(logger.getCounts()).toEqual({ windowCount: 2, offlineCount: 0 })
  })

  it('posts VIDEO_PLAY with the window count and clears it', async () => {
    const logger = createVideoPlayLogController(memoryStore())
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    logger.recordFullscreen()
    logger.recordFullscreen()
    logger.recordFullscreen()

    await logger.flush(postLog)

    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 3 }])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 0 })
  })

  it('moves the window count offline when the log API fails', async () => {
    const logger = createVideoPlayLogController(memoryStore())
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
    const logger = createVideoPlayLogController(memoryStore({ windowCount: 0, offlineCount: 4 }))
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
    const logger = createVideoPlayLogController(memoryStore({ windowCount: 0, offlineCount: 4 }))
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(false)
    logger.recordFullscreen()

    await logger.flush(postLog)

    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 1 }])
    expect(logger.getCounts()).toEqual({ windowCount: 0, offlineCount: 5 })
  })

  it('retries VIDEO_PLAY_OFFLINE when that call fails after an online VIDEO_PLAY', async () => {
    const logger = createVideoPlayLogController(memoryStore({ windowCount: 0, offlineCount: 3 }))
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
    const logger = createVideoPlayLogController(memoryStore())
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)

    await logger.flush(postLog)

    expect(postLog).not.toHaveBeenCalled()
  })

  it('ignores an overlapping flush so counts are not double-sent', async () => {
    const logger = createVideoPlayLogController(memoryStore())
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

  it('posts once per 24 hours', async () => {
    expect(VIDEO_PLAY_LOG_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)

    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const logger = createVideoPlayLogController(
      memoryStore({ windowCount: 2, offlineCount: 0, lastFlushAt: now })
    )
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    const stop = logger.start(postLog)

    await vi.advanceTimersByTimeAsync(0)
    expect(postLog).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(VIDEO_PLAY_LOG_INTERVAL_MS)
    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 2 }])

    stop()
  })

  it('flushes immediately when the previous 24h window is already due', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const logger = createVideoPlayLogController(
      memoryStore({
        windowCount: 1,
        offlineCount: 0,
        lastFlushAt: now - VIDEO_PLAY_LOG_INTERVAL_MS
      })
    )
    const postLog = vi.fn<PostVideoPlayLog>().mockResolvedValue(true)
    const stop = logger.start(postLog)

    await vi.advanceTimersByTimeAsync(0)
    expect(posted(postLog)).toEqual([{ event: 'VIDEO_PLAY', fullscreenClicks: 1 }])

    stop()
  })
})
