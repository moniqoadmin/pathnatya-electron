import { getConnectivity } from './connectivity'

const SPEED_PROBE_BYTES = 100_000
const SPEED_PROBE_HOST = 'https://speed.cloudflare.com/__down'
const SPEED_PROBE_URL = `${SPEED_PROBE_HOST}?bytes=${SPEED_PROBE_BYTES}`
const CLOUDFLARE_PROBE_TIMEOUT_MS = 8_000

/** Thrown when the API host cannot be reached (Wi-Fi up, no route / DNS / timeout). */
export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NetworkError'
  }
}

/** Call this rather than reading `navigator.onLine` inline; repeated inline
 *  comparisons make the compiler narrow the property to a literal. */
export function isOffline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }

  // A link with no reachable server counts as offline for download/cleanup gating.
  return getConnectivity() === 'offline'
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }

  if (error instanceof TypeError) {
    return true
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('offline') ||
      message.includes('internet')
    )
  }

  return false
}

export type ProbeOnline = (signal?: AbortSignal) => Promise<boolean>

/** True when the Cloudflare speed endpoint responds (internet is actually reachable). */
export async function probeCloudflare(signal?: AbortSignal): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false
  }

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), CLOUDFLARE_PROBE_TIMEOUT_MS)
  const onAbort = (): void => timeout.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const url = `${SPEED_PROBE_HOST}?bytes=1&r=${Date.now()}`
    const response = await fetch(url, { cache: 'no-store', signal: timeout.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Measured download throughput in Mbps, or null when offline / probe failed. */
export async function measureDownloadSpeed(signal?: AbortSignal): Promise<number | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return null
  }

  const url = `${SPEED_PROBE_URL}&r=${Date.now()}`
  const started = performance.now()
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) {
    throw new Error(`Speed probe failed (${response.status})`)
  }

  const data = await response.arrayBuffer()
  const elapsedSec = Math.max((performance.now() - started) / 1000, 0.001)
  return (data.byteLength * 8) / (elapsedSec * 1_000_000)
}

/** Warn a bit before playback usually starts buffering hard. */
export const LOW_NETWORK_SPEED_KBPS = 500

export function isLowDownloadSpeed(mbps: number | null): boolean {
  if (mbps === null || !Number.isFinite(mbps)) {
    return false
  }
  return mbps * 1000 < LOW_NETWORK_SPEED_KBPS
}
