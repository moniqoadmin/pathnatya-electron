import { useConnectivity } from '../lib/connectivity'

export default function OfflineToast() {
  const connectivity = useConnectivity()

  if (connectivity !== 'offline') {
    return null
  }

  return (
    <div className="toast toast-offline" role="status" aria-live="polite">
      4710 : No internet connection
    </div>
  )
}
