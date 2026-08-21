import { DAILY_ONLINE_POLL_MS, DAILY_ONLINE_TICK_MS } from '../../../shared/daily-online-tick'
import type { PostAppLogOptions } from '../api/logs'
import { probeCloudflare } from './network'

export const VIDEO_PLAY_LOG_INTERVAL_MS = DAILY_ONLINE_TICK_MS
export const VIDEO_PLAY_LOG_POLL_MS = DAILY_ONLINE_POLL_MS

const STORAGE_KEY = 'pathnatya_video_play_log'

/** Fail fast so a dead connection is treated as offline within the daily tick. */
const FLUSH_OPTIONS: PostAppLogOptions = {
  timeoutMs: 8_000,
  retries: 0
}

export type VideoPlayLogCounts = {
  windowCount: number
  offlineCount: number
  /** Epoch ms of the last successful Cloudflare-gated tick (next due = this + 24h). */
  lastFlushAt?: number
}

export type PostVideoPlayLog = (
  event: 'VIDEO_PLAY' | 'VIDEO_PLAY_OFFLINE',
  tampered: boolean,
  authToken?: string,
  fetchOptions?: PostAppLogOptions
) => Promise<boolean>

export type ProbeOnline = (signal?: AbortSignal) => Promise<boolean>

export type VideoPlayLogStore = {
  read: () => VideoPlayLogCounts
  write: (counts: VideoPlayLogCounts) => void
}

export type VideoPlayLogOptions = {
  probeOnline?: ProbeOnline
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
  store: VideoPlayLogStore = localStorageStore(),
  options: VideoPlayLogOptions = {}
): {
  recordFullscreen: () => void
  flush: (postLog: PostVideoPlayLog) => Promise<void>
  start: (postLog: PostVideoPlayLog, pollMs?: number) => () => void
  getCounts: () => VideoPlayLogCounts
} {
  const probeOnline = options.probeOnline ?? probeCloudflare
  let flushing = false
  let probing = false

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

  function msUntilDue(intervalMs: number): number {
    const last = store.read().lastFlushAt
    if (last == null) {
      return intervalMs
    }

    return Math.max(0, last + intervalMs - Date.now())
  }

  async function tick(postLog: PostVideoPlayLog): Promise<void> {
    if (probing || flushing) {
      return
    }

    probing = true
    try {
      const online = await probeOnline()
      if (!online) {
        return
      }

      if (msUntilDue(VIDEO_PLAY_LOG_INTERVAL_MS) > 0) {
        return
      }

      // Cloudflare reached: roll the window to tomorrow this time, then POST once.
      patch({ lastFlushAt: Date.now() })
      await flush(postLog)
    } finally {
      probing = false
    }
  }

  function start(postLog: PostVideoPlayLog, pollMs = VIDEO_PLAY_LOG_POLL_MS): () => void {
    if (store.read().lastFlushAt == null) {
      patch({ lastFlushAt: Date.now() })
    }

    const run = (): void => {
      void tick(postLog)
    }

    const timeoutId = setTimeout(run, 0)
    const intervalId = setInterval(run, pollMs)

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

/** Probe Cloudflare every 5 minutes; POST play logs once when a due tick is online. */
export function startVideoPlayLogWatch(postLog: PostVideoPlayLog): () => void {
  return defaultController.start(postLog)
}
