import { DAILY_ONLINE_POLL_MS } from '../../../shared/daily-online-tick'
import { probeCloudflare, type ProbeOnline } from './network'

export type TrustedTimeDailyWatchOptions = {
  probeOnline?: ProbeOnline
  isDue?: () => Promise<boolean>
  sync?: () => Promise<unknown>
  pollMs?: number
}

/**
 * Probe Cloudflare every 5 minutes. GET /health/time only after Cloudflare
 * succeeds and the 24h tick is due; that success restarts the tick for tomorrow.
 */
export function startTrustedTimeDailyWatch(options: TrustedTimeDailyWatchOptions = {}): () => void {
  const probeOnline = options.probeOnline ?? probeCloudflare
  const isDue =
    options.isDue ?? (() => window.pathnatya.isTrustedTimeDailyTickDue())
  const sync = options.sync ?? (() => window.pathnatya.syncTrustedTimeOnDailyTick())
  const pollMs = options.pollMs ?? DAILY_ONLINE_POLL_MS

  let probing = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped || probing) {
      return
    }

    probing = true
    try {
      const online = await probeOnline()
      if (!online) {
        return
      }

      if (!(await isDue())) {
        return
      }

      await sync()
    } catch (error) {
      console.warn('[trusted-time] daily tick failed; will retry next poll', error)
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
