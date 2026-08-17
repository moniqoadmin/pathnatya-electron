import { hasOfflineVideoPackage } from './hls-offline'
import {
  isOfflineRebootLimitReached,
  isTrustedCheckInExpired,
  loadTrustedTime,
  syncTrustedTime,
  TRUSTED_CHECKIN_TTL_MS
} from './trusted-time'

/** Offline downloads must re-verify server time at least this often. */
export const OFFLINE_CHECKIN_TTL_MS = TRUSTED_CHECKIN_TTL_MS

/**
 * True when a downloaded offline video exists and either the 2-day check-in
 * window has elapsed or offline reboots have reached the backend `numberOfReboot`
 * cap. Never deletes video files — login is refused until the next successful
 * online sync.
 */
export async function isOfflineCheckInRequired(): Promise<boolean> {
  if (!(await hasOfflineVideoPackage())) {
    return false
  }

  await loadTrustedTime()
  return isTrustedCheckInExpired(OFFLINE_CHECKIN_TTL_MS) || isOfflineRebootLimitReached()
}

/** Re-stamp the 2-day window from server GMT. No-op (returns false) when offline. */
export async function renewOfflineCheckIn(): Promise<boolean> {
  try {
    await syncTrustedTime()
    return true
  } catch (error) {
    console.warn('[offline-checkin] renew failed', error)
    return false
  }
}
