import { hasOfflineVideoPackage, deleteOfflineVideo } from './hls-offline'
import { clearMemoryVideo } from './hls-memory'
import {
  getConfiguredOfflineWindowMs,
  getConfiguredVideoEndDate,
  loadHlsAppConfiguration
} from './hls-config'
import {
  isOfflineRebootLimitReached,
  isTrustedCheckInExpired,
  isTrustedExpired,
  loadTrustedTime
} from './trusted-time'
import { DEFAULT_OFFLINE_WINDOW_MS } from '../shared/app-configuration'

/** Fallback check-in window when app configuration has not been loaded. */
export const OFFLINE_CHECKIN_TTL_MS = DEFAULT_OFFLINE_WINDOW_MS

/**
 * True when the session should end: `END_DATE` has passed (downloaded and
 * in-memory video are deleted), or a downloaded offline video exists and
 * either the `OFFLINE_WINDOW` check-in (default 2 days) has elapsed or
 * offline reboots have reached the backend `numberOfReboot` cap. Check-in
 * expiry never deletes video files — login is refused until the next
 * successful online sync.
 */
export async function isOfflineCheckInRequired(): Promise<boolean> {
  await loadHlsAppConfiguration()
  await loadTrustedTime()

  const endDate = getConfiguredVideoEndDate()
  if (endDate && isTrustedExpired(endDate)) {
    try {
      await deleteOfflineVideo()
    } catch (error) {
      console.warn('[offline-checkin] failed to delete video after END_DATE', error)
    }
    clearMemoryVideo()
    return true
  }

  if (!(await hasOfflineVideoPackage())) {
    return false
  }

  return (
    isTrustedCheckInExpired(getConfiguredOfflineWindowMs()) || isOfflineRebootLimitReached()
  )
}
