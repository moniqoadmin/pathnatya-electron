interface LandingPageProps {
  onContinue: () => void
}

export default function LandingPage({ onContinue }: LandingPageProps) {
  return (
    <div className="page landing-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Pathnatya 2026</h1>
      </header>

      <section className="guidelines card">
        <h2>Guidelines to access the video</h2>
        <ul>
          <li>Once your password is set, it cannot be reset again. Please choose it carefully.</li>
          <li>Use only one laptop to access the video throughout the event.</li>
          <li>
            The video cannot be accessed from any other laptop once you have logged in on your
            registered device.
          </li>
          <li>You will be automatically logged out after 60 minutes.</li>
          <li>
            Download the video while online to watch it offline for 7 days on this device.
          </li>
          <li>
            Offline login is available for 7 days after a successful online login on this device.
          </li>
          <li>Video access will be removed after 15 August 2026.</li>
        </ul>
      </section>

      <button type="button" className="btn btn-primary" onClick={onContinue}>
        Continue
      </button>
    </div>
  )
}
