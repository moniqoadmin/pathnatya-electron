import { useEffect, useState } from 'react'

export default function OfflineToast() {
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false
  )

  useEffect(() => {
    const handleOffline = (): void => setOffline(true)
    const handleOnline = (): void => setOffline(false)

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    setOffline(navigator.onLine === false)

    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  if (!offline) {
    return null
  }

  return (
    <div className="toast toast-offline" role="status" aria-live="polite">
      4710 : No internet connection
    </div>
  )
}
