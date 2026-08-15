import { useEffect, useState } from 'react'

interface TamperWarningProps {
  /** Parent folder paths where the copies were found (no file names). */
  locations: string[]
  seconds: number
}

export default function TamperWarning({ locations, seconds }: TamperWarningProps) {
  const [remaining, setRemaining] = useState(seconds)

  useEffect(() => {
    setRemaining(seconds)

    const intervalId = window.setInterval(() => {
      setRemaining((value) => (value > 0 ? value - 1 : 0))
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [seconds])

  const shown =
    locations.length > 0 ? locations : (['Location unavailable'] as const)

  return (
    <div
      className="tamper-warning"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tamper-warning-title"
    >
      <div className="tamper-warning-card">
        <h2 id="tamper-warning-title" className="tamper-warning-title">
        6924 : Duplicate app instance detected
        </h2>
        <p className="tamper-warning-text">
        A duplicate app instance has been detected. Please sign out and sign in again.
        </p>
        <ul className="tamper-warning-paths">
          {shown.map((location, index) => (
            <li key={`${index}-${location}`} className="tamper-warning-path">
              {location}
            </li>
          ))}
        </ul>
        <p className="tamper-warning-countdown" aria-live="polite">
          Logging out in {remaining}s
        </p>
      </div>
    </div>
  )
}
