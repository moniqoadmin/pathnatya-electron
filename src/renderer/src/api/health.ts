import { majorVersion } from '../../../shared/video-version'
import { API_BASE, APP_KEY } from './config'

export async function fetchServerVersion(): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(`${API_BASE}/health`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'X-App-Key': APP_KEY },
      signal: controller.signal
    })
    if (!res.ok) {
      return null
    }

    const data: unknown = await res.json()
    if (!data || typeof data !== 'object' || !('version' in data)) {
      return null
    }

    const version = (data as { version: unknown }).version
    if (typeof version === 'string' && version.trim()) {
      return version.trim()
    }
    if (typeof version === 'number' && Number.isFinite(version)) {
      return String(version)
    }
    return null
  } catch {
    return null
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export function isNewerVersion(remote: string, current: string): boolean {
  return majorVersion(remote) > majorVersion(current)
}
