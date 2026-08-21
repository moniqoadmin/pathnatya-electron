import { majorVersion } from '../../../shared/video-version'

/** Server app version from the startup GET /health/time (no second HTTP call). */
export async function fetchServerVersion(): Promise<string | null> {
  try {
    return await window.pathnatya.getServerAppVersion()
  } catch {
    return null
  }
}

export function isNewerVersion(remote: string, current: string): boolean {
  return majorVersion(remote) > majorVersion(current)
}
