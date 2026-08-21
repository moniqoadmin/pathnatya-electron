import { useEffect, useState } from 'react'

const INSTALL_MESSAGE_DELAY_MS = 4000

export default function UpdateRequiredPage() {
  const [showInstallMessage, setShowInstallMessage] = useState(true)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShowInstallMessage(true)
    }, INSTALL_MESSAGE_DELAY_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [])

  return (
    <div className="page landing-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Pathnatya 2026</h1>
        <p className="page-subtitle">New Version Available. Uninstall this and install new.</p>
        {showInstallMessage && <p className="page-subtitle">Install new version.</p>}
      </header>
    </div>
  )
}
