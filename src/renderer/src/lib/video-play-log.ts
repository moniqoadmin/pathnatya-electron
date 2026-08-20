import type { PostAppLogOptions } from '../api/logs'

export const VIDEO_PLAY_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000

const STORAGE_KEY = 'pathnatya_video_play_log'

/** Fail fast so a dead connection is treated as offline within the daily tick. */
const FLUSH_OPTIONS: PostAppLogOptions = {
  timeoutMs: 8_000,
  retries: 0
}

export type VideoPlayLogCounts = {
  windowCount: number
  offlineCount: number
  /** Epoch ms of the last flush attempt (or when the 24h window started). */
  lastFlushAt?: number
}

export type PostVideoPlayLog = (
  event: 'VIDEO_PLAY' | 'VIDEO_PLAY_OFFLINE',
  tampered: boolean,
  authToken?: string,
  fetchOptions?: PostAppLogOptions
) => Promise<boolean>

export type VideoPlayLogStore = {
  read: () => VideoPlayLogCounts
  write: (counts: VideoPlayLogCounts) => void
}

function emptyCounts(): VideoPlayLogCounts {
  return { windowCount: 0, offlineCount: 0 }
}

function normalizeCounts(value: unknown): VideoPlayLogCounts {
  if (!value || typeof value !== 'object') {
    return emptyCounts()
  }

  const record = value as {
    windowCount?: unknown
    offlineCount?: unknown
    lastFlushAt?: unknown
  }
  const windowCount = Number(record.windowCount)
  const offlineCount = Number(record.offlineCount)
  const lastFlushAt = Number(record.lastFlushAt)

  const counts: VideoPlayLogCounts = {
    windowCount: Number.isFinite(windowCount) && windowCount > 0 ? Math.floor(windowCount) : 0,
    offlineCount: Number.isFinite(offlineCount) && offlineCount > 0 ? Math.floor(offlineCount) : 0
  }

  if (Number.isFinite(lastFlushAt) && lastFlushAt > 0) {
    counts.lastFlushAt = Math.floor(lastFlushAt)
  }

  return counts
}

function localStorageStore(): VideoPlayLogStore {
  return {
    read(): VideoPlayLogCounts {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) {
          return emptyCounts()
        }
        return normalizeCounts(JSON.parse(raw) as unknown)
      } catch {
        return emptyCounts()
      }
    },
    write(counts: VideoPlayLogCounts): void {
      try {
        if (counts.windowCount <= 0 && counts.offlineCount <= 0 && counts.lastFlushAt == null) {
          localStorage.removeItem(STORAGE_KEY)
          return
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(counts))
      } catch {
        /* ignore quota / private mode */
      }
    }
  }
}

export function createVideoPlayLogController(
  store: VideoPlayLogStore = localStorageStore()
): {
  recordFullscreen: () => void
  flush: (postLog: PostVideoPlayLog) => Promise<void>
  start: (postLog: PostVideoPlayLog, intervalMs?: number) => () => void
  getCounts: () => VideoPlayLogCounts
} {
  let flushing = false

  function getCounts(): VideoPlayLogCounts {
    return store.read()
  }

  function patch(partial: Partial<VideoPlayLogCounts>): void {
    store.write({ ...store.read(), ...partial })
  }

  function recordFullscreen(): void {
    const counts = store.read()
    patch({ windowCount: counts.windowCount + 1 })
  }

  async function sendPlayLog(
    postLog: PostVideoPlayLog,
    event: 'VIDEO_PLAY' | 'VIDEO_PLAY_OFFLINE',
    fullscreenClicks: number
  ): Promise<boolean> {
    try {
      return await postLog(event, false, undefined, {
        ...FLUSH_OPTIONS,
        metadata: { fullscreenClicks }
      })
    } catch (error) {
      console.error(`Unable to report ${event} log:`, error)
      return false
    }
  }

  async function flush(postLog: PostVideoPlayLog): Promise<void> {
    if (flushing) {
      return
    }

    const snapshot = store.read()
    if (snapshot.windowCount <= 0 && snapshot.offlineCount <= 0) {
      return
    }

    flushing = true
    patch({ windowCount: 0, offlineCount: snapshot.offlineCount })

    try {
      if (snapshot.windowCount > 0) {
        const sent = await sendPlayLog(postLog, 'VIDEO_PLAY', snapshot.windowCount)
        if (!sent) {
          const latest = store.read()
          patch({
            windowCount: latest.windowCount,
            offlineCount: latest.offlineCount + snapshot.windowCount
          })
          return
        }
      }

      const offlineCount = store.read().offlineCount
      if (offlineCount <= 0) {
        return
      }

      const sentOffline = await sendPlayLog(postLog, 'VIDEO_PLAY_OFFLINE', offlineCount)
      if (sentOffline) {
        patch({ windowCount: store.read().windowCount, offlineCount: 0 })
      }
    } finally {
      flushing = false
    }
  }

  async function flushWindow(postLog: PostVideoPlayLog): Promise<void> {
    await flush(postLog)
    patch({ lastFlushAt: Date.now() })
  }

  function msUntilDue(intervalMs: number): number {
    const last = store.read().lastFlushAt
    if (last == null) {
      return intervalMs
    }

    return Math.max(0, last + intervalMs - Date.now())
  }

  function start(postLog: PostVideoPlayLog, intervalMs = VIDEO_PLAY_LOG_INTERVAL_MS): () => void {
    if (store.read().lastFlushAt == null) {
      patch({ lastFlushAt: Date.now() })
    }

    const run = (): void => {
      void flushWindow(postLog)
    }

    let intervalId = 0
    const timeoutId = setTimeout(() => {
      run()
      intervalId = setInterval(run, intervalMs)
    }, msUntilDue(intervalMs))

    return () => {
      clearTimeout(timeoutId)
      clearInterval(intervalId)
    }
  }

  return { recordFullscreen, flush, start, getCounts }
}

const defaultController = createVideoPlayLogController()

/** Count a successful enter-fullscreen as one video play. */
export function recordVideoPlayFullscreen(): void {
  defaultController.recordFullscreen()
}

/** Every 24 hours, POST batched fullscreen counts (or queue them as offline). */
export function startVideoPlayLogWatch(postLog: PostVideoPlayLog): () => void {
  return defaultController.start(postLog)
}
