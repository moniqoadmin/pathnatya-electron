import { useCallback, useEffect, useRef, useState } from 'react'

interface LandingPageProps {
  onContinue: () => void
}

const SCROLL_BOTTOM_THRESHOLD_PX = 24

export default function LandingPage({ onContinue }: LandingPageProps) {
  const guidelinesRef = useRef<HTMLElement>(null)
  const [reachedBottom, setReachedBottom] = useState(false)

  const updateReachedBottom = useCallback(() => {
    const el = guidelinesRef.current
    if (!el) {
      return
    }

    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remaining <= SCROLL_BOTTOM_THRESHOLD_PX) {
      setReachedBottom(true)
    }
  }, [])

  useEffect(() => {
    const el = guidelinesRef.current
    if (!el) {
      return
    }

    updateReachedBottom()
    el.addEventListener('scroll', updateReachedBottom, { passive: true })

    const resizeObserver = new ResizeObserver(updateReachedBottom)
    resizeObserver.observe(el)

    return () => {
      el.removeEventListener('scroll', updateReachedBottom)
      resizeObserver.disconnect()
    }
  }, [updateReachedBottom])

  return (
    <div className="page landing-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Pathnatya 2026</h1>
      </header>

      <section ref={guidelinesRef} className="guidelines card">
        <h2>Guidelines to access the video</h2>

        <h3>General Guidelines</h3>
        <ol>
          <li>
            The app should be accessed and downloaded only by the coordinator of your team. Do not
            share the app with anyone.
          </li>
          <li>Watch the video together with the entire team.</li>
          <li>No one should record the video.</li>
          <li>The video will play only on one laptop throughout the practice sessions.</li>
          <li>
            There is no logout option on the platform. When done, you can close the window. In case
            the login screen reappears, kindly login again.
          </li>
          <li>
            If you have any questions, please connect with the respective Sannidhata for support.
            They will be able to guide you.
          </li>
        </ol>

        <h3>Play Pathnatya Video</h3>
        <ol start={7}>
          <li>
            Please make sure you have a good internet connection while accessing the Pathnatya video
            for the first time.
          </li>
          <li>Please wait while the application is preparing the Pathnatya Video.</li>
          <li>Full screen is required to play the video.</li>
        </ol>

        <h3>Replay the Pathnatya Video</h3>
        <ol start={10}>
          <li>Come back to the Pathnatya App and login if necessary.</li>
          <li>A message that full screen is required to play the video will appear.</li>
          <li>Click the Full screen video to play.</li>
        </ol>
      </section>

      <div className="landing-continue">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onContinue}
          disabled={!reachedBottom}
        >
          Continue
        </button>
        {!reachedBottom && (
          <p className="landing-continue-hint">Scroll to the bottom to continue</p>
        )}
      </div>
    </div>
  )
}
