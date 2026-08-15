import { apiFetch } from './client'
import { getSession } from '../lib/storage'

export type AppLogEvent =
  | 'DOM_CHANGED'
  | 'SCREEN_CAPTURE_STARTED'
  | 'SCREEN_CAPTURE_CLEARED'
  | 'DEVTOOLS_SHORTCUT'
  | 'DEVTOOLS_OPENED'
  | 'FILES_TAMPERED'
  | 'VIDEO_FILES_CHANGED'
  | 'VM_DETECTED'
  | 'CLOCK_MISMATCH'

export async function postAppLog(event: AppLogEvent, tampered: boolean): Promise<boolean> {
  const session = getSession()
  if (!session?.token) {
    return false
  }

  await apiFetch<void>('/logs', {
    method: 'POST',
    authToken: session.token,
    json: event === 'FILES_TAMPERED' ? { event, threat: true } : { event, tampered }
  })
  return true
}

export function reportAppLog(event: AppLogEvent, tampered: boolean): void {
  void postAppLog(event, tampered).catch((error) => {
    console.error(`Unable to report ${event} log:`, error)
  })
}
