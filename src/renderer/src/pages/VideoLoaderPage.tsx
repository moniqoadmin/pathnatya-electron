import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type Hls from 'hls.js'
import type { Account } from '../api/accounts'
import {
  IconDownload,
  IconFullscreen,
  IconFullscreenExit,
  IconLock,
  IconPause,
  IconPlay,
  IconRefresh,
  IconSeekBack,
  IconSeekForward,
  IconVolume,
  IconVolumeMute,
  SEEK_STEP_S
} from '../components/VideoIcons'
import {
  attachHlsPlayer,
  cancelHlsDownload,
  clearHlsPlayback,
  downloadHlsVideo,
  getHlsOfflineStatus,
  isHlsSupported,
  onHlsDownloadProgress,
  prepareHlsPlayback
} from '../lib/hls-loader'
import { isLowDownloadSpeed, isOffline } from '../lib/network'
import { readStoredVolume, writeStoredVolume } from '../lib/player-prefs'
import { clearAllStorage, clearSession } from '../lib/storage'
import { drawWatermarkedFrame, formatTime } from '../lib/video-frame'

type OfflineStatus = Awaited<ReturnType<typeof getHlsOfflineStatus>>

interface VideoLoaderPageProps {
  account: Account
  sessionTimeoutMs: number
  onLogout: () => void
}

/** Scene markers for the ~18 min video (times in seconds). */
const VIDEO_SCENES: Array<{ scene: number; label: string; time: number }> = [
  { scene: 1, label: 'Scene 1', time: 1 * 60 },
  { scene: 2, label: 'Scene 2', time: 5 * 60 },
  { scene: 3, label: 'Scene 3', time: 9 * 60 },
  { scene: 4, label: 'Scene 4', time: 13 * 60 },
  { scene: 5, label: 'Scene 5', time: 16 * 60 }
]

const BANDWIDTH_POLL_MS = 5000

export default function VideoLoaderPage({
  account,
  sessionTimeoutMs,
  onLogout
}: VideoLoaderPageProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const volumeRef = useRef(readStoredVolume())
  const lastAudibleVolumeRef = useRef(volumeRef.current > 0 ? volumeRef.current : 1)

  const [reloadToken, setReloadToken] = useState(0)
  const [playbackReady, setPlaybackReady] = useState(false)
  const [videoLoading, setVideoLoading] = useState(true)
  const [videoError, setVideoError] = useState('')
  const [buffering, setBuffering] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => volumeRef.current)
  const [networkMbps, setNetworkMbps] = useState<number | null>(null)
  const [offlineStatus, setOfflineStatus] = useState<OfflineStatus | null>(null)
  const [downloadError, setDownloadError] = useState('')
  const [fromOffline, setFromOffline] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const watermarkText = account.phoneNumber
  const showLowNetworkSpeed = isLowDownloadSpeed(networkMbps) && !fromOffline

  function formatExpiry(iso: string | null): string {
    if (!iso) {
      return ''
    }

    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) {
      return ''
    }

    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  const drawFrame = useEffectEvent(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (video && canvas) {
      drawWatermarkedFrame(video, canvas, watermarkText)
    }
  })

  const togglePlay = useEffectEvent(() => {
    const video = videoRef.current
    if (!video || document.fullscreenElement !== videoContainerRef.current) {
      return
    }

    if (video.paused) {
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  })

  const seekTo = useEffectEvent((value: number) => {
    const video = videoRef.current
    if (!video) {
      return
    }

    const max = duration || video.duration || 0
    const next = Math.min(Math.max(value, 0), max)
    video.currentTime = next
    setCurrentTime(next)
  })

  const seekBy = useEffectEvent((deltaSeconds: number) => {
    const video = videoRef.current
    seekTo((video?.currentTime ?? currentTime) + deltaSeconds)
  })

  const setPlayerVolume = useEffectEvent((next: number) => {
    const clamped = Math.min(1, Math.max(0, next))
    volumeRef.current = clamped
    if (clamped > 0) {
      lastAudibleVolumeRef.current = clamped
    }
    writeStoredVolume(clamped)

    const video = videoRef.current
    if (video) {
      video.volume = clamped
    }
    setVolume(clamped)
  })

  const enterFullscreen = useEffectEvent(() => {
    const container = videoContainerRef.current
    if (!container || document.fullscreenElement) {
      return
    }

    void container.requestFullscreen().catch(() => {})
  })

  const toggleFullscreen = useEffectEvent(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }

    enterFullscreen()
  })

  // Playback is only allowed in fullscreen, so leaving it pauses the video.
  useEffect(() => {
    const onFullscreenChange = (): void => {
      const active = document.fullscreenElement === videoContainerRef.current
      setIsFullscreen(active)

      const video = videoRef.current
      if (!video) {
        return
      }

      if (active) {
        void video.play().catch(() => {})
      } else if (!video.paused) {
        video.pause()
      }
    }

    onFullscreenChange()
    document.addEventListener('fullscreenchange', onFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [])

  // Resolve the playlist in main, then hand the decrypted stream to hls.js.
  useEffect(() => {
    let cancelled = false

    async function loadVideo(): Promise<void> {
      setPlaybackReady(false)
      setVideoLoading(true)
      setVideoError('')
      setBuffering(false)
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      setFromOffline(false)
      setDownloadError('')

      hlsRef.current?.destroy()
      hlsRef.current = null

      try {
        if (!isHlsSupported()) {
          throw new Error('This build of Chromium cannot play HLS streams.')
        }

        const prepared = await prepareHlsPlayback()
        if (cancelled) {
          return
        }

        const video = videoRef.current
        if (!video) {
          throw new Error('Video player is not ready.')
        }

        setFromOffline(prepared.fromOffline)
        setDuration(prepared.totalDurationSeconds)
        video.volume = volumeRef.current

        hlsRef.current = attachHlsPlayer(video, prepared.playlistUrl, (message) => {
          if (!cancelled) {
            setVideoError(message)
          }
        })

        setPlaybackReady(true)
        void getHlsOfflineStatus().then((status) => {
          if (!cancelled) {
            setOfflineStatus(status)
          }
        })
      } catch (error) {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Unable to prepare video.'
        setVideoError(message)
      } finally {
        if (!cancelled) {
          setVideoLoading(false)
        }
      }
    }

    void loadVideo()

    return () => {
      cancelled = true
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [reloadToken])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackReady) {
      return
    }

    const onPlay = (): void => setIsPlaying(true)
    const onPause = (): void => setIsPlaying(false)
    const onWaiting = (): void => setBuffering(true)
    const onPlaying = (): void => setBuffering(false)
    const onTimeUpdate = (): void => setCurrentTime(video.currentTime)
    const onEnded = (): void => setIsPlaying(false)

    const onLoadedMetadata = (): void => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
      }
      video.volume = volumeRef.current
      if (document.fullscreenElement === videoContainerRef.current) {
        void video.play().catch(() => {})
      }
    }

    const onVolumeChange = (): void => {
      volumeRef.current = video.volume
      if (video.volume > 0) {
        lastAudibleVolumeRef.current = video.volume
      }
      writeStoredVolume(video.volume)
      setVolume(video.volume)
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', onEnded)
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('volumechange', onVolumeChange)

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('volumechange', onVolumeChange)
    }
  }, [playbackReady])

  useEffect(() => {
    if (!playbackReady) {
      return
    }

    let frameId = 0
    let running = true

    const tick = (): void => {
      if (!running) {
        return
      }

      drawFrame()
      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)

    return () => {
      running = false
      window.cancelAnimationFrame(frameId)
    }
  }, [playbackReady])

  // hls.js already measures throughput, so no extra probe request is needed.
  useEffect(() => {
    if (!playbackReady) {
      return
    }

    const readBandwidth = (): void => {
      if (isOffline()) {
        setNetworkMbps(null)
        return
      }

      const estimate = hlsRef.current?.bandwidthEstimate
      setNetworkMbps(typeof estimate === 'number' && estimate > 0 ? estimate / 1_000_000 : null)
    }

    readBandwidth()
    const intervalId = window.setInterval(readBandwidth, BANDWIDTH_POLL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [playbackReady])

  useEffect(() => {
    if (!playbackReady) {
      return
    }

    let cancelled = false

    void (async () => {
      const packaged = await window.pathnatya.isPackaged()
      if (cancelled || !packaged) {
        return
      }

      enterFullscreen()
    })()

    return () => {
      cancelled = true
    }
  }, [playbackReady])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!playbackReady) {
        return
      }

      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        togglePlay()
        return
      }

      if (event.repeat) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'a' || key === 'arrowleft') {
        event.preventDefault()
        seekBy(-SEEK_STEP_S)
        return
      }

      if (key === 'd' || key === 'arrowright') {
        event.preventDefault()
        seekBy(SEEK_STEP_S)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [playbackReady])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      clearHlsPlayback()
      clearAllStorage()
      onLogout()
    }, sessionTimeoutMs)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [sessionTimeoutMs, onLogout])

  useEffect(() => {
    const unsubscribe = window.pathnatya.onSessionInterrupted(() => {
      void window.pathnatya.setSessionGuard(false)
      hlsRef.current?.destroy()
      hlsRef.current = null
      clearHlsPlayback()
      clearAllStorage()
      onLogout()
    })

    void window.pathnatya.setSessionGuard(true)

    return () => {
      unsubscribe()
      void window.pathnatya.setSessionGuard(false)
    }
  }, [onLogout])

  useEffect(() => {
    return () => {
      clearHlsPlayback()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void getHlsOfflineStatus().then((status) => {
      if (!cancelled) {
        setOfflineStatus(status)
      }
    })

    const unsubscribe = onHlsDownloadProgress((progress) => {
      setOfflineStatus(progress)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function handleDownload(): Promise<void> {
    if (
      !account.isOffline ||
      offlineStatus?.downloading ||
      offlineStatus?.available ||
      isOffline()
    ) {
      return
    }

    setDownloadError('')
    try {
      const status = await downloadHlsVideo()
      setOfflineStatus(status)
      setFromOffline(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to download video.'
      if (!message.toLowerCase().includes('cancelled')) {
        setDownloadError(message)
      }
      const status = await getHlsOfflineStatus()
      setOfflineStatus(status)
    }
  }

  async function handleCancelDownload(): Promise<void> {
    await cancelHlsDownload()
  }

  function handleLogout(): void {
    hlsRef.current?.destroy()
    hlsRef.current = null
    clearHlsPlayback()
    clearSession()
    onLogout()
  }

  function handleRefresh(): void {
    if (videoLoading || offlineStatus?.downloading) {
      return
    }
    setReloadToken((token) => token + 1)
  }

  const offlineBadge =
    offlineStatus?.available && offlineStatus.expiresAt
      ? `Offline until ${formatExpiry(offlineStatus.expiresAt)}`
      : fromOffline
        ? 'Playing offline'
        : ''

  return (
    <div className="page video-page">
      <header className="app-topbar">
        <div className="app-topbar-title">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1>Pathnatya 2026</h1>
        </div>
        <button type="button" className="app-topbar-logout" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <section ref={videoContainerRef} className="video-card card">
        <div className="video-overlay-actions">
          {showLowNetworkSpeed && (
            <p className="video-network-warning" role="status" aria-live="polite">
              Low internet speed
            </p>
          )}
          {offlineBadge && (
            <p className="video-offline-badge" role="status" aria-live="polite">
              {offlineBadge}
            </p>
          )}
          {account.isOffline &&
            (offlineStatus?.downloading ? (
              <>
                <p className="video-download-progress" role="status" aria-live="polite">
                  Downloading {offlineStatus.percent}%
                </p>
                <button
                  type="button"
                  className="video-overlay-btn video-overlay-btn-text"
                  onClick={() => void handleCancelDownload()}
                >
                  Cancel
                </button>
              </>
            ) : (
              !offlineStatus?.available && (
                <button
                  type="button"
                  className="video-overlay-btn video-overlay-btn-icon"
                  onClick={() => void handleDownload()}
                  aria-label="Download for offline"
                  title="Download for offline (7 days)"
                  disabled={videoLoading || isOffline()}
                >
                  <IconDownload />
                </button>
              )
            ))}
          <button
            type="button"
            className="video-overlay-btn video-overlay-btn-icon"
            onClick={handleRefresh}
            aria-label="Restart video"
            title="Restart video"
            disabled={videoLoading || Boolean(offlineStatus?.downloading)}
          >
            <IconRefresh />
          </button>
          {isFullscreen && (
            <button
              type="button"
              className="video-overlay-btn video-overlay-btn-icon"
              onClick={toggleFullscreen}
              aria-label="Exit full screen"
              title="Exit full screen"
            >
              <IconFullscreenExit />
            </button>
          )}
        </div>

        <div className="video-player">
          {videoLoading && <p className="video-status">Preparing video...</p>}
          {buffering && !videoLoading && !videoError && (
            <p className="video-status video-status-seek">Loading...</p>
          )}
          {downloadError && !videoError && (
            <p className="form-error video-download-error" role="alert">
              {downloadError}
            </p>
          )}
          {videoError && <p className="form-error video-status">{videoError}</p>}

          <video
            ref={videoRef}
            className="source-video"
            controls={false}
            controlsList="nodownload noplaybackrate noremoteplayback nofullscreen"
            disablePictureInPicture
            playsInline
            preload="auto"
          />

          {playbackReady && (
            <>
              <canvas
                ref={canvasRef}
                className="main-video video-canvas"
                onClick={togglePlay}
                onContextMenu={(event) => event.preventDefault()}
              />
              <div className="video-controls">
                <button
                  type="button"
                  className="video-control-btn video-control-icon"
                  onClick={() => seekBy(-SEEK_STEP_S)}
                  aria-label={`Rewind ${SEEK_STEP_S} seconds`}
                  title={`Rewind ${SEEK_STEP_S} seconds (A / ←)`}
                >
                  <IconSeekBack />
                </button>
                <button
                  type="button"
                  className="video-control-btn video-control-icon video-control-play"
                  onClick={togglePlay}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  title={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <IconPause /> : <IconPlay />}
                </button>
                <button
                  type="button"
                  className="video-control-btn video-control-icon"
                  onClick={() => seekBy(SEEK_STEP_S)}
                  aria-label={`Forward ${SEEK_STEP_S} seconds`}
                  title={`Forward ${SEEK_STEP_S} seconds (D / →)`}
                >
                  <IconSeekForward />
                </button>

                <div className="video-seek-wrap">
                  <input
                    type="range"
                    className="video-seek"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(event) => seekTo(Number(event.target.value))}
                    aria-label="Seek"
                  />
                  {duration > 0 &&
                    VIDEO_SCENES.filter((scene) => scene.time < duration).map((scene) => (
                      <button
                        key={scene.scene}
                        type="button"
                        className="video-scene-marker"
                        style={{ left: `${(scene.time / duration) * 100}%` }}
                        title={`${scene.label} · ${formatTime(scene.time)}`}
                        aria-label={`Jump to ${scene.label} at ${formatTime(scene.time)}`}
                        onClick={() => seekTo(scene.time)}
                      />
                    ))}
                </div>

                <span className="video-time">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>

                <div className="video-volume-control">
                  <div className="video-volume-popup">
                    <input
                      type="range"
                      className="video-volume-slider"
                      min={0}
                      max={1}
                      step={0.05}
                      value={volume}
                      onChange={(event) => setPlayerVolume(Number(event.target.value))}
                      aria-label="Volume"
                      title={`${Math.round(volume * 100)}%`}
                    />
                  </div>
                  <button
                    type="button"
                    className="video-control-btn video-control-icon"
                    onClick={() => setPlayerVolume(volume > 0 ? 0 : lastAudibleVolumeRef.current)}
                    aria-label={volume > 0 ? 'Mute' : 'Unmute'}
                    title={volume > 0 ? 'Mute' : 'Unmute'}
                  >
                    {volume > 0 ? <IconVolume /> : <IconVolumeMute />}
                  </button>
                </div>
              </div>
            </>
          )}

          {!isFullscreen && !videoLoading && !videoError && (
            <div className="video-fullscreen-gate" role="alertdialog" aria-live="polite">
              <span className="video-fullscreen-gate-lock" aria-hidden="true">
                <IconLock />
              </span>
              <p className="video-fullscreen-gate-text">
                Full screen is required to play the video
              </p>
              <button
                type="button"
                className="video-fullscreen-gate-btn"
                onClick={toggleFullscreen}
                aria-label="Enter full screen"
                title="Enter full screen"
              >
                <IconFullscreen />
              </button>
              <p className="video-fullscreen-gate-hint">Click the icon to go full screen</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
