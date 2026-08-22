import { DAILY_ONLINE_POLL_MS } from '../../../shared/daily-online-tick'

export type OfflineCheckInWatchOptions = {
  isRequired?: () => Promise<boolean>
  onRequired?: () => void
  pollMs?: number
}

/**
 * While a session is active, re-check `END_DATE` and the offline check-in every
 * 5 minutes. If access has ended or the window has expired, ask the app to end
 * the session. `END_DATE` deletes the video in main; check-in expiry leaves it.
 */
export function startOfflineCheckInWatch(options: OfflineCheckInWatchOptions = {}): () => void {
  const isRequired =
    options.isRequired ?? (() => window.pathnatya.isOfflineCheckInRequired())
  const onRequired = options.onRequired
  const pollMs = options.pollMs ?? DAILY_ONLINE_POLL_MS

  let probing = false
  let stopped = false
  let fired = false

  const tick = async (): Promise<void> => {
    if (stopped || probing || fired || !onRequired) {
      return
    }

    probing = true
    try {
      if (await isRequired()) {
        fired = true
        onRequired()
      }
    } catch (error) {
      console.warn('[offline-checkin] poll failed; will retry next interval', error)
    } finally {
      probing = false
    }
  }

  const run = (): void => {
    void tick()
  }

  const timeoutId = setTimeout(run, 0)
  const intervalId = setInterval(run, pollMs)

  return () => {
    stopped = true
    clearTimeout(timeoutId)
    clearInterval(intervalId)
  }
}
