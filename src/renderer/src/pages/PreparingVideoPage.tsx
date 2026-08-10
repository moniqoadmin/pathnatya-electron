import { useEffect, useRef, useState } from 'react'
import OfflineToast from '../components/OfflineToast'
import { downloadHlsVideo, getHlsOfflineStatus, onHlsDownloadProgress } from '../lib/hls-loader'

interface PreparingVideoPageProps {
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

export default function PreparingVideoPage({ onReady, onLogout }: PreparingVideoPageProps) {
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const readyRef = useRef(false)

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
        const status = await getHlsOfflineStatus()
        if (cancelled) {
          return
        }

        // A returning user already has the video on this device, so skip ahead.
        if (status.available && !status.downloading) {
          finish(0)
          return
        }

        setPercent(status.percent)
        if (status.downloading) {
          return
        }

        const result = await downloadHlsVideo()
        if (cancelled) {
          return
        }

        if (result.available) {
          finish()
        } else {
          setError('We could not prepare your video. Please try again.')
        }
      } catch (caught) {
        if (cancelled) {
          return
        }

        const message = caught instanceof Error ? caught.message : ''
        // The main process may already be working on it from an earlier attempt.
        if (message.toLowerCase().includes('already in progress')) {
          return
        }

        setError('We could not prepare your video. Check your internet connection and try again.')
      }
    })()

    return () => {
      cancelled = true
      window.clearTimeout(holdTimeoutId)
      unsubscribe()
    }
  }, [attempt, onReady])

  function handleRetry(): void {
    readyRef.current = false
    setError('')
    setPercent(0)
    setAttempt((value) => value + 1)
  }

  return (
    <div className="page preparing-page">
      <OfflineToast />

      <header className="app-topbar">
        <div className="app-topbar-title">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1>Pathnatya 2026</h1>
        </div>
        <button type="button" className="app-topbar-logout" onClick={onLogout}>
          Logout
        </button>
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
          <span>{error ? 'Something went wrong' : stageMessage(percent)}</span>
          <span className="preparing-percent">{Math.min(100, Math.max(0, percent))}%</span>
        </p>

        {error && (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <button type="button" className="btn btn-primary" onClick={handleRetry}>
              Try again
            </button>
          </>
        )}
      </section>
    </div>
  )
}
