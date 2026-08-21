import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type Hls from 'hls.js'
import type { Account } from '../api/accounts'
import { postAppLog, reportAppLog } from '../api/logs'
import OfflineToast from '../components/OfflineToast'
import {
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
  clearHlsOfflineVideo,
  clearHlsPlayback,
  isHlsSupported,
  isVideoFilesTamperedError,
  lockLoginAfterVideoTamper,
  prepareHlsPlayback,
  VIDEO_FILES_TAMPERED_MESSAGE
} from '../lib/hls-loader'
import { isLowDownloadSpeed, isOffline } from '../lib/network'
import { readStoredVolume, writeStoredVolume } from '../lib/player-prefs'
import { userError } from '../lib/user-error'
import { watchVideoPlayerDom } from '../lib/dom-integrity'
import {
  clearAllStorage,
  clearSession,
  getWatermarkPhoneNumber,
  getWatermarkTeamNumber
} from '../lib/storage'
import { drawWatermarkedFrame, formatTime } from '../lib/video-frame'
import { recordVideoPlayFullscreen, startVideoPlayLogWatch } from '../lib/video-play-log'

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
const WATERMARK_REFRESH_MS = 2000

function formatDetectedApps(apps: string[], fallback: string): string {
  if (apps.length === 0) {
    return `Detected: ${fallback}`
  }

  if (apps.length === 1) {
    return `Detected: ${apps[0]}`
  }

  return `Detected:\n${apps.map((name) => `• ${name}`).join('\n')}`
}

export default function VideoLoaderPage({
  account,
  sessionTimeoutMs,
  onLogout
}: VideoLoaderPageProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const videoPlayerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const volumeRef = useRef(readStoredVolume())
  const lastAudibleVolumeRef = useRef(volumeRef.current > 0 ? volumeRef.current : 1)
  const fullscreenEnteredAtRef = useRef(0)
  const wasFullscreenRef = useRef(false)
  const captureActiveRef = useRef(false)
  const captureWasActiveRef = useRef<boolean | null>(null)
  const vmReportedRef = useRef(false)
  const clockReportedRef = useRef(false)
  const videoTamperReportedRef = useRef(false)
  const playbackReadyRef = useRef(false)
  const watermarkTextRef = useRef(
    getWatermarkPhoneNumber() || String(account.phoneNumber ?? '')
  )
  const watermarkTeamRef = useRef(
    getWatermarkTeamNumber() ?? (account.teamNumber == null ? '' : String(account.teamNumber))
  )

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
  const [fromOffline, setFromOffline] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [captureActive, setCaptureActive] = useState(false)
  const [captureApps, setCaptureApps] = useState<string[]>([])
  const [captureReason, setCaptureReason] = useState<
    '' | 'recorder' | 'virtual-machine' | 'clock-mismatch' | 'always-on-top'
  >('')

  const showLowNetworkSpeed = isLowDownloadSpeed(networkMbps) && !fromOffline

  const drawFrame = useEffectEvent(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (video && canvas) {
      drawWatermarkedFrame(video, canvas, watermarkTextRef.current, watermarkTeamRef.current)
    }
  })

  const togglePlay = useEffectEvent(() => {
    const video = videoRef.current
    if (
      !video ||
      captureActiveRef.current ||
      document.fullscreenElement !== videoContainerRef.current
    ) {
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
    if (!container || captureActiveRef.current || document.fullscreenElement) {
      return
    }

    fullscreenEnteredAtRef.current = Date.now()
    void container.requestFullscreen().catch(() => {})
  })

  const toggleFullscreen = useEffectEvent(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }

    enterFullscreen()
  })

  /** Pauses playback and drops back to the fullscreen gate. */
  const enforceFullscreenGate = useEffectEvent(() => {
    const video = videoRef.current
    if (video && !video.paused) {
      video.pause()
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  })

  useEffect(() => startVideoPlayLogWatch(postAppLog), [])

  // Playback is only allowed in fullscreen, so leaving it pauses the video.
  useEffect(() => {
    const onFullscreenChange = (): void => {
      const active = document.fullscreenElement === videoContainerRef.current
      if (active && !wasFullscreenRef.current) {
        recordVideoPlayFullscreen()
      }
      wasFullscreenRef.current = active
      setIsFullscreen(active)

      const video = videoRef.current
      if (!video) {
        return
      }

      if (active && !captureActiveRef.current) {
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

  // Leaving the app (OS focus loss / hidden / minimise) exits fullscreen and pauses.
  useEffect(() => {
    // macOS animates entering fullscreen into a new Space, which briefly blurs
    // the window and can fire visibilitychange. Defer during this grace window so
    // we don't get kicked out the instant we enter.
    const FULLSCREEN_GRACE_MS = 1500
    let graceTimeoutId = 0

    const isAway = (): boolean => document.hidden || !document.hasFocus()

    const handleAway = (): void => {
      const sinceEntered = Date.now() - fullscreenEnteredAtRef.current
      if (sinceEntered < FULLSCREEN_GRACE_MS) {
        window.clearTimeout(graceTimeoutId)
        graceTimeoutId = window.setTimeout(() => {
          if (isAway()) {
            enforceFullscreenGate()
          }
        }, FULLSCREEN_GRACE_MS - sinceEntered)
        return
      }

      enforceFullscreenGate()
    }

    const onBlur = (): void => {
      handleAway()
    }

    const onVisibilityChange = (): void => {
      if (document.hidden) {
        handleAway()
      }
    }

    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const unsubscribeWindowBlur = window.pathnatya.onWindowBlur(() => {
      handleAway()
    })

    return () => {
      window.clearTimeout(graceTimeoutId)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribeWindowBlur()
    }
  }, [])

  // A screen recorder / remote-control app, a VM, a wrong system clock, or another
  // always-on-top window means playback stops and the fullscreen gate takes over.
  useEffect(() => {
    const applyCaptureState = (state: {
      active: boolean
      appName: string
      appNames?: string[]
      reason: '' | 'recorder' | 'virtual-machine' | 'clock-mismatch' | 'always-on-top'
    }): void => {
      const apps =
        state.appNames && state.appNames.length > 0
          ? state.appNames
          : state.appName
            ? state.appName.split(',').map((name) => name.trim()).filter(Boolean)
            : []

      captureActiveRef.current = state.active
      setCaptureActive(state.active)
      setCaptureApps(apps)
      setCaptureReason(state.reason)

      if (state.reason === 'virtual-machine') {
        if (!vmReportedRef.current) {
          vmReportedRef.current = true
          reportAppLog('VM_DETECTED', true, { apps })
        }
      } else if (state.reason === 'clock-mismatch') {
        if (!clockReportedRef.current) {
          clockReportedRef.current = true
          reportAppLog('CLOCK_MISMATCH', true)
        }
      } else if (state.reason === 'always-on-top') {
        // App-level AlwaysOnTopGate + /logs; here we only pause playback.
      } else {
        if (state.reason === 'recorder') {
          const previous = captureWasActiveRef.current
          if (previous !== true) {
            captureWasActiveRef.current = true
            reportAppLog('SCREEN_CAPTURE_STARTED', true, { apps })
          }
        } else if (captureWasActiveRef.current === true) {
          captureWasActiveRef.current = false
          reportAppLog('SCREEN_CAPTURE_CLEARED', false)
        } else if (captureWasActiveRef.current === null) {
          captureWasActiveRef.current = false
        }
      }

      if (state.active) {
        enforceFullscreenGate()
      }
    }

    let cancelled = false

    void window.pathnatya.getScreenCaptureState().then((state) => {
      if (!cancelled) {
        applyCaptureState(state)
      }
    })

    const unsubscribe = window.pathnatya.onScreenCaptureChanged(applyCaptureState)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Report unexpected edits inside the video-player subtree (injections / media removal).
  useEffect(() => {
    const root = videoPlayerRef.current
    if (!root) {
      return
    }

    return watchVideoPlayerDom(root, {
      isCanvasExpected: () => playbackReadyRef.current,
      onTampered: () => {
        reportAppLog('DOM_CHANGED', true)
      }
    })
  }, [])

  // Resolve the playlist in main, then hand the decrypted stream to hls.js.
  useEffect(() => {
    let cancelled = false

    async function loadVideo(): Promise<void> {
      playbackReadyRef.current = false
      setPlaybackReady(false)
      setVideoLoading(true)
      setVideoError('')
      setBuffering(false)
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      setFromOffline(false)

      hlsRef.current?.destroy()
      hlsRef.current = null

      try {
        if (!isHlsSupported()) {
          throw new Error(userError(391, 'This build of Chromium cannot play HLS streams.'))
        }

        // Online-only accounts must not keep or play a local offline package.
        if (!account.isOffline) {
          await clearHlsOfflineVideo()
        }

        const prepared = await prepareHlsPlayback()
        if (cancelled) {
          return
        }

        const video = videoRef.current
        if (!video) {
          throw new Error(userError(7642, 'Video player is not ready.'))
        }

        setFromOffline(prepared.fromOffline)
        setDuration(prepared.totalDurationSeconds)
        video.volume = volumeRef.current

        hlsRef.current = attachHlsPlayer(video, prepared.playlistUrl, (message) => {
          if (!cancelled) {
            setVideoError(message)
          }
        })

        playbackReadyRef.current = true
        setPlaybackReady(true)
      } catch (error) {
        if (cancelled) {
          return
        }

        // A locked/altered offline package blocks the main process from wiping it.
        // Treat as tampering: log it once and show the contact-admin message.
        if (isVideoFilesTamperedError(error)) {
          if (!videoTamperReportedRef.current) {
            videoTamperReportedRef.current = true
            lockLoginAfterVideoTamper()
            reportAppLog('VIDEO_FILES_CHANGED', true)
          }
          setVideoError(VIDEO_FILES_TAMPERED_MESSAGE)
          return
        }

        const message =
          error instanceof Error
            ? userError(4518, error.message)
            : userError(4518, 'Unable to prepare video.')
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
  }, [reloadToken, account.isOffline])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackReady) {
      return
    }

    const onPlay = (): void => {
      if (captureActiveRef.current || document.fullscreenElement !== videoContainerRef.current) {
        video.pause()
        return
      }

      setIsPlaying(true)
    }
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
    if (!playbackReady || !isFullscreen) {
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
  }, [playbackReady, isFullscreen])

  // Silently re-assert the login-time phone and team snapshots so in-memory edits do not stick.
  useEffect(() => {
    if (!playbackReady) {
      return
    }

    const refreshWatermark = (): void => {
      const phone = getWatermarkPhoneNumber()
      if (phone) {
        watermarkTextRef.current = phone
      }

      const team = getWatermarkTeamNumber()
      if (team != null) {
        watermarkTeamRef.current = team
      }
    }

    refreshWatermark()
    const intervalId = window.setInterval(refreshWatermark, WATERMARK_REFRESH_MS)

    return () => {
      window.clearInterval(intervalId)
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
      // Session expiry logs out but keeps the in-memory video for the next login.
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
      hlsRef.current?.destroy()
      hlsRef.current = null
      clearHlsPlayback()
      clearAllStorage()
      onLogout()
    })

    return () => {
      unsubscribe()
    }
  }, [onLogout])

  useEffect(() => {
    return () => {
      // Detach playback only — do not wipe the RAM package on leave/logout.
      clearHlsPlayback()
    }
  }, [])

  function handleLogout(): void {
    hlsRef.current?.destroy()
    hlsRef.current = null
    clearHlsPlayback()
    clearSession()
    onLogout()
  }

  function handleRefresh(): void {
    if (videoLoading) {
      return
    }
    setReloadToken((token) => token + 1)
  }

  return (
    <div className="page video-page">
      <header className="app-topbar">
        <div className="app-topbar-title">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1>Pathnatya 2026</h1>
        </div>
        {account.logoutButton === true && (
          <button type="button" className="app-topbar-logout" onClick={handleLogout}>
            Logout
          </button>
        )}
      </header>

      <section ref={videoContainerRef} className="video-card card">
        {/* Inside the fullscreen element so the toast stays visible during playback. */}
        {!account.isOffline && <OfflineToast />}

        <div className="video-overlay-actions">
          {showLowNetworkSpeed && (
            <p className="video-network-warning" role="status" aria-live="polite">
              3318 : Low internet speed
            </p>
          )}
          <button
            type="button"
            className="video-overlay-btn video-overlay-btn-icon"
            onClick={handleRefresh}
            aria-label="Restart video"
            title="Restart video"
            disabled={videoLoading}
          >
            <IconRefresh />
          </button>
          {fromOffline && (
            <span
              className="video-local-dot"
              aria-hidden="true"
              title="Playing prepared video"
            />
          )}
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

        <div ref={videoPlayerRef} className="video-player">
          {videoLoading && <p className="video-status">Loading video...</p>}
          {buffering && !videoLoading && !videoError && (
            <p className="video-status video-status-seek">Loading...</p>
          )}
          {/* While blocked, the gate below carries the explanation instead. */}
          {videoError && !captureActive && <p className="form-error video-status">{videoError}</p>}

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

          {!isFullscreen &&
            !videoLoading &&
            captureReason !== 'always-on-top' &&
            (!videoError || captureActive) && (
            <div className="video-fullscreen-gate" role="alertdialog" aria-live="polite">
              <span className="video-fullscreen-gate-lock" aria-hidden="true">
                <IconLock />
              </span>
              {captureReason === 'virtual-machine' ? (
                <>
                  <p className="video-fullscreen-gate-text">845 : Virtual machine detected</p>
                  <p className="video-capture-app">
                    {formatDetectedApps(captureApps, 'a virtual machine')}
                  </p>
                  <p className="video-fullscreen-gate-hint">
                    The video cannot be played inside a virtual machine, because the host can
                    record the screen. Open Pathnatya on a physical Windows or macOS laptop.
                  </p>
                </>
              ) : captureReason === 'clock-mismatch' ? (
                <>
                  <p className="video-fullscreen-gate-text">2904 : System clock does not match</p>
                  <p className="video-fullscreen-gate-hint">
                    This computer&apos;s GMT time does not match the server. Turn on automatic
                    date &amp; time in system settings, then restart Pathnatya to watch the video.
                  </p>
                </>
              ) : captureActive ? (
                <>
                  <p className="video-fullscreen-gate-text">
                    6183 : Screen recording or sharing detected
                  </p>
                  <p className="video-capture-app">
                    {formatDetectedApps(captureApps, 'a capture app')}
                  </p>
                  <p className="video-fullscreen-gate-hint">
                    Playback is paused. Stop the recording or screen share to continue watching.
                  </p>
                </>
              ) : (
                <>
                  <p className="video-fullscreen-gate-text">
                    1274 : Full screen is required to play the video
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
                </>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
