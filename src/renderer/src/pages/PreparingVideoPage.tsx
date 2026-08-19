import { useEffect, useRef, useState } from 'react'
import { reportAppLog } from '../api/logs'
import OfflineToast from '../components/OfflineToast'
import {
  cancelHlsDownload,
  downloadHlsVideo,
  downloadHlsVideoMemory,
  getHlsMemoryStatus,
  getHlsOfflineStatus,
  isVideoFilesTamperedError,
  onHlsDownloadProgress,
  VIDEO_FILES_TAMPERED_MESSAGE
} from '../lib/hls-loader'
import { isOffline } from '../lib/network'
import { extractCodedError, userError } from '../lib/user-error'

interface PreparingVideoPageProps {
  /** Disk package for offline accounts; RAM-only for online accounts. */
  storage: 'disk' | 'memory'
  showLogoutButton?: boolean
  onReady: () => void
  onLogout: () => void
}

/** Keeps the bar at 100% long enough to read before the player takes over. */
const READY_HOLD_MS = 900

function stageMessage(percent: number): string {
  if (percent < 20) {
    return 'Setting things up for you...'
  }
  if (percent < 60) {
    return 'Preparing your video...'
  }
  if (percent < 95) {
    return 'Almost ready...'
  }
  return 'Finishing up...'
}

export default function PreparingVideoPage({
  storage,
  showLogoutButton = false,
  onReady,
  onLogout
}: PreparingVideoPageProps) {
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [tampered, setTampered] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const readyRef = useRef(false)
  const tamperReportedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let holdTimeoutId = 0

    const finish = (holdMs = READY_HOLD_MS): void => {
      if (readyRef.current) {
        return
      }

      readyRef.current = true
      setPercent(100)

      if (holdMs === 0) {
        onReady()
        return
      }

      holdTimeoutId = window.setTimeout(() => {
        if (!cancelled) {
          onReady()
        }
      }, holdMs)
    }

    const unsubscribe = onHlsDownloadProgress((progress) => {
      if (cancelled) {
        return
      }

      setPercent(progress.percent)
      if (progress.available && !progress.downloading) {
        finish()
      }
    })

    void (async () => {
      try {
        const status =
          storage === 'memory' ? await getHlsMemoryStatus() : await getHlsOfflineStatus()
        if (cancelled) {
          return
        }

        // Returning user already has the video (disk or still in RAM after logout).
        if (status.available && !status.downloading) {
          finish(0)
          return
        }

        setPercent(status.percent)
        if (status.downloading) {
          return
        }

        // Offline and no usable package: do not start a download (and never wipe).
        if (isOffline()) {
          setError(
            userError(
              9372,
              'We could not prepare your video. Check your internet connection and try again.'
            )
          )
          return
        }

        const result =
          storage === 'memory' ? await downloadHlsVideoMemory() : await downloadHlsVideo()
        if (cancelled) {
          return
        }

        if (result.available) {
          finish()
        } else {
          setError(userError(248, 'We could not prepare your video. Please try again.'))
        }
      } catch (caught) {
        if (cancelled) {
          return
        }

        console.error('[preparing-video] download failed', caught)
        const message = caught instanceof Error ? caught.message : ''
        // The main process may already be working on it from an earlier attempt.
        if (message.toLowerCase().includes('already in progress')) {
          return
        }

        // A locked/altered offline package blocks the main process from wiping it.
        // Treat as tampering: log it once and show the contact-admin message.
        if (storage === 'disk' && isVideoFilesTamperedError(caught)) {
          if (!tamperReportedRef.current) {
            tamperReportedRef.current = true
            reportAppLog('VIDEO_FILES_CHANGED', true)
          }
          setTampered(true)
          setError(VIDEO_FILES_TAMPERED_MESSAGE)
          return
        }

        setError(
          extractCodedError(message) ??
            userError(
              9372,
              'We could not prepare your video. Check your internet connection and try again.'
            )
        )
      }
    })()

    return () => {
      cancelled = true
      window.clearTimeout(holdTimeoutId)
      unsubscribe()
    }
  }, [attempt, onReady, storage])

  function handleRetry(): void {
    readyRef.current = false
    setError('')
    setTampered(false)
    setPercent(0)
    setAttempt((value) => value + 1)
  }

  function handleLogoutClick(): void {
    // Stop an in-flight prepare so logout does not leave a half-built package.
    void cancelHlsDownload()
    onLogout()
  }

  return (
    <div className="page preparing-page">
      <OfflineToast />

      <header className="app-topbar">
        <div className="app-topbar-title">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1>Pathnatya 2026</h1>
        </div>
        {showLogoutButton && (
          <button type="button" className="app-topbar-logout" onClick={handleLogoutClick}>
            Logout
          </button>
        )}
      </header>

      <section className="preparing-card card">
        <h2>Preparing your video</h2>
        <p className="preparing-hint">
          This takes a few minutes the first time. Please keep the app open and stay connected.
        </p>

        <div
          className="preparing-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Preparing your video"
        >
          <div
            className="preparing-fill"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>

        <p className="preparing-status" role="status" aria-live="polite">
          <span>
            {error
              ? tampered
                ? '573 : Video files tampered'
                : `${error.split(' : ')[0]} : Something went wrong`
              : stageMessage(percent)}
          </span>
          <span className="preparing-percent">{Math.min(100, Math.max(0, percent))}%</span>
        </p>

        {error && (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            {!tampered && (
              <button type="button" className="btn btn-primary" onClick={handleRetry}>
                Try again
              </button>
            )}
          </>
        )}
      </section>
    </div>
  )
}
