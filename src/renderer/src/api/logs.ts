import { apiFetch } from './client'
import { getDeviceId } from '../lib/device-id'
import { getSession } from '../lib/storage'

export type AppLogEvent =
  | 'DOM_CHANGED'
  | 'SCREEN_CAPTURE_STARTED'
  | 'SCREEN_CAPTURE_CLEARED'
  | 'ALWAYS_ON_TOP_DETECTED'
  | 'ALWAYS_ON_TOP_CLEARED'
  | 'DEVTOOLS_SHORTCUT'
  | 'DEVTOOLS_OPENED'
  | 'FILES_TAMPERED'
  | 'VIDEO_FILES_CHANGED'
  | 'VM_DETECTED'
  | 'CLOCK_MISMATCH'
  | 'RENDER_CRASH'
  | 'VIDEO_PLAY'
  | 'VIDEO_PLAY_OFFLINE'

export type AppLogMetadata = Record<string, unknown>

export type PostAppLogOptions = {
  timeoutMs?: number
  retries?: number
  metadata?: AppLogMetadata
}

/** Drop duplicate fire-and-forget reports for the same event within this window. */
const LOG_DEDUPE_MS = 60_000

const lastReportedAt = new Map<string, number>()
const inFlight = new Set<string>()

function logKey(event: AppLogEvent, tampered: boolean): string {
  return `${event}:${tampered ? '1' : '0'}`
}

export async function postAppLog(
  event: AppLogEvent,
  tampered: boolean,
  authToken?: string,
  fetchOptions?: PostAppLogOptions
): Promise<boolean> {
  const token = authToken ?? getSession()?.token
  if (!token) {
    return false
  }

  let ipAddress = ''
  try {
    ipAddress = await getDeviceId()
  } catch {
    ipAddress = ''
  }

  const metadata = fetchOptions?.metadata
  await apiFetch<void>('/logs', {
    method: 'POST',
    authToken: token,
    json: {
      event,
      tampered,
      ipAddress,
      ...(metadata ? { metadata } : {})
    },
    timeoutMs: fetchOptions?.timeoutMs,
    retries: fetchOptions?.retries
  })
  return true
}

/**
 * Best-effort security/ops log. Dedupes and serializes per event so a noisy
 * detector (DOM mutations, capture flaps) cannot stampede `/logs` at launch.
 */
export function reportAppLog(event: AppLogEvent, tampered: boolean): void {
  const key = logKey(event, tampered)
  const now = Date.now()

  if (inFlight.has(key)) {
    return
  }

  const last = lastReportedAt.get(key) ?? 0
  if (now - last < LOG_DEDUPE_MS) {
    return
  }

  // Mark before send so concurrent bursts collapse into one request.
  lastReportedAt.set(key, now)
  inFlight.add(key)

  void postAppLog(event, tampered)
    .catch((error) => {
      console.error(`Unable to report ${event} log:`, error)
    })
    .finally(() => {
      inFlight.delete(key)
    })
}
