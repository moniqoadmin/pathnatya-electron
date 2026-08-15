import Hls, { ErrorTypes, Events, FetchLoader } from 'hls.js'
import { isOffline } from './network'
import { userError } from './user-error'

export interface PreparedHlsPlayback {
  playlistUrl: string
  totalDurationSeconds: number
  segmentCount: number
  fromOffline: boolean
  expiresAt: string | null
}

/** Shown when the offline package cannot be cleaned up because its files were locked/altered. */
export const VIDEO_FILES_TAMPERED_MESSAGE = userError(
  573,
  'Video files tampered. Please contact admin.'
)

/**
 * A locked/replaced offline package makes the main process fail to wipe `hls-offline`
 * (e.g. `EPERM: operation not permitted, rmdir ...hls-offline`). We treat this as tampering.
 */
export function isVideoFilesTamperedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  if (!message.includes('hls-offline')) {
    return false
  }

  return message.includes('eperm') || message.includes('operation not permitted')
}

/**
 * Ask the main process to resolve the playlist (offline package first, then CDN).
 * Returns a `pathnatya://` playlist whose segments are decrypted in main.
 */
export async function prepareHlsPlayback(sourceUrl?: string): Promise<PreparedHlsPlayback> {
  return window.pathnatya.prepareHlsVideo(sourceUrl)
}

export async function getHlsOfflineStatus() {
  return window.pathnatya.getHlsOfflineStatus()
}

export async function downloadHlsVideo(sourceUrl?: string) {
  return window.pathnatya.downloadHlsVideo(sourceUrl)
}

export async function cancelHlsDownload() {
  return window.pathnatya.cancelHlsDownload()
}

export async function clearHlsOfflineVideo() {
  // Never erase the local package while offline — logout and account checks
  // would otherwise force a re-download the user cannot complete.
  if (isOffline()) {
    return
  }

  return window.pathnatya.clearHlsOfflineVideo()
}

export function onHlsDownloadProgress(
  callback: (progress: Awaited<ReturnType<typeof getHlsOfflineStatus>>) => void
) {
  return window.pathnatya.onHlsDownloadProgress(callback)
}

export function clearHlsPlayback(): void {
  void window.pathnatya.clearHlsVideo()
}

export function isHlsSupported(): boolean {
  return Hls.isSupported()
}

export function attachHlsPlayer(
  video: HTMLVideoElement,
  playlistUrl: string,
  onFatalError: (message: string) => void
): Hls {
  const hls = new Hls({
    // The `pathnatya://` scheme is fetch-enabled but not XHR-friendly.
    loader: FetchLoader,
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 60,
    maxMaxBufferLength: 180,
    backBufferLength: 30
  })

  let networkRetries = 0
  let mediaRecoveries = 0

  hls.on(Events.ERROR, (_event, data) => {
    if (!data.fatal) {
      return
    }

    if (data.type === ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
      networkRetries += 1
      hls.startLoad()
      return
    }

    if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
      mediaRecoveries += 1
      hls.recoverMediaError()
      return
    }

    onFatalError(userError(8264, data.error?.message || 'Unable to play the video stream.'))
  })

  hls.on(Events.FRAG_LOADED, () => {
    networkRetries = 0
  })

  hls.attachMedia(video)
  hls.loadSource(playlistUrl)

  return hls
}
