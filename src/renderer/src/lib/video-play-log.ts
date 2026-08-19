import type { PostAppLogOptions } from '../api/logs'

export const VIDEO_PLAY_LOG_INTERVAL_MS = 5 * 60 * 1000

const STORAGE_KEY = 'pathnatya_video_play_log'

/** Fail fast so a dead connection is treated as offline within the 5-minute tick. */
const FLUSH_OPTIONS: PostAppLogOptions = {
  timeoutMs: 8_000,
  retries: 0
}

export type VideoPlayLogCounts = {
  windowCount: number
  offlineCount: number
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

  const record = value as { windowCount?: unknown; offlineCount?: unknown }
  const windowCount = Number(record.windowCount)
  const offlineCount = Number(record.offlineCount)

  return {
    windowCount: Number.isFinite(windowCount) && windowCount > 0 ? Math.floor(windowCount) : 0,
    offlineCount: Number.isFinite(offlineCount) && offlineCount > 0 ? Math.floor(offlineCount) : 0
  }
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
        if (counts.windowCount <= 0 && counts.offlineCount <= 0) {
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

  function recordFullscreen(): void {
    const counts = store.read()
    store.write({ ...counts, windowCount: counts.windowCount + 1 })
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
    store.write({ windowCount: 0, offlineCount: snapshot.offlineCount })

    try {
      if (snapshot.windowCount > 0) {
        const sent = await sendPlayLog(postLog, 'VIDEO_PLAY', snapshot.windowCount)
        if (!sent) {
          const latest = store.read()
          store.write({
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
        const latest = store.read()
        store.write({ windowCount: latest.windowCount, offlineCount: 0 })
      }
    } finally {
      flushing = false
    }
  }

  function start(postLog: PostVideoPlayLog, intervalMs = VIDEO_PLAY_LOG_INTERVAL_MS): () => void {
    const intervalId = window.setInterval(() => {
      void flush(postLog)
    }, intervalMs)

    return () => {
      window.clearInterval(intervalId)
    }
  }

  return { recordFullscreen, flush, start, getCounts }
}

const defaultController = createVideoPlayLogController()

/** Count a successful enter-fullscreen as one video play. */
export function recordVideoPlayFullscreen(): void {
  defaultController.recordFullscreen()
}

/** Every 5 minutes, POST batched fullscreen counts (or queue them as offline). */
export function startVideoPlayLogWatch(postLog: PostVideoPlayLog): () => void {
  return defaultController.start(postLog)
}
