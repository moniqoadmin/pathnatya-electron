import { APP_KEY, API_BASE } from './config'
import { decryptPayload, encryptPayload } from './payload-crypto'
import { getConnectivity, reportNetworkFailure, reportNetworkSuccess } from '../lib/connectivity'
import { NetworkError } from '../lib/network'
import { userError } from '../lib/user-error'

const UNREACHABLE_SERVER_MESSAGE = userError(
  503,
  'Unable to reach the server. Check your connection and try again.'
)
const REQUEST_TIMEOUT_MESSAGE = userError(
  408,
  'Request timed out. Check your connection and try again.'
)

export type ApiFetchOptions = RequestInit & {
  json?: unknown
  authToken?: string
  /** Override the default 30s request timeout. */
  timeoutMs?: number
  /** Override the default retry count (extra attempts after the first). */
  retries?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 2
const BASE_BACKOFF_MS = 1000

function collectErrorParts(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectErrorParts)
  }

  if (value && typeof value === 'object' && 'message' in value) {
    return collectErrorParts((value as { message: unknown }).message)
  }

  return []
}

function errorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') {
    return fallback
  }

  const record = data as Record<string, unknown>
  const parts = [...collectErrorParts(record.message), ...collectErrorParts(record.errors)]
  if (parts.length === 0) {
    parts.push(...collectErrorParts(record.error))
  }

  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join('\n') : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function backoffMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 250)
  return BASE_BACKOFF_MS * 2 ** attempt + jitter
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isFetchNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const {
    json,
    authToken,
    headers: initHeaders,
    body: initBody,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    signal: callerSignal,
    ...rest
  } = options

  const maxAttempts = Math.max(1, retries + 1)
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const headers = new Headers(initHeaders)
    headers.set('X-App-Key', APP_KEY)

    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`)
    }

    let body = initBody
    if (json !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify({ payload: await encryptPayload(json) })
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    const onCallerAbort = (): void => {
      controller.abort()
    }
    callerSignal?.addEventListener('abort', onCallerAbort)
    if (callerSignal?.aborted) {
      controller.abort()
    }

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...rest,
        headers,
        body,
        signal: controller.signal
      })
      reportNetworkSuccess()
      const contentType = res.headers.get('content-type') ?? ''

      if (isRetryableStatus(res.status) && attempt < maxAttempts - 1) {
        // Drain the body so the connection can be reused, then back off.
        void res.arrayBuffer().catch(() => {})
        await sleep(backoffMs(attempt))
        continue
      }

      // Binary downloads (template) — no decrypt
      if (contentType.includes('spreadsheet') || contentType.includes('octet-stream')) {
        if (!res.ok) {
          throw new Error(userError(4102, `HTTP ${res.status}`))
        }
        return (await res.blob()) as T
      }

      if (res.status === 204) {
        return undefined as T
      }

      const envelope = await res.json()
      if (typeof envelope?.payload !== 'string') {
        throw new Error(userError(3847, 'Expected encrypted payload response'))
      }

      const data = await decryptPayload<T>(envelope.payload)
      if (!res.ok) {
        throw Object.assign(new Error(userError(917, errorMessage(data, 'API error'))), {
          status: res.status,
          data
        })
      }

      return data
    } catch (error) {
      lastError = error

      if (callerSignal?.aborted) {
        throw error
      }

      const retryable = isTimeoutError(error) || isFetchNetworkFailure(error)
      if (retryable) {
        reportNetworkFailure()
      }

      // Retrying is pointless once a request (or the OS) has already shown we
      // cannot reach the server; failing fast lets callers switch to offline mode.
      if (retryable && attempt < maxAttempts - 1 && getConnectivity() !== 'offline') {
        await sleep(backoffMs(attempt))
        continue
      }

      if (isTimeoutError(error)) {
        throw new NetworkError(REQUEST_TIMEOUT_MESSAGE, { cause: error })
      }

      if (isFetchNetworkFailure(error)) {
        throw new NetworkError(UNREACHABLE_SERVER_MESSAGE, { cause: error })
      }

      throw error
    } finally {
      window.clearTimeout(timeoutId)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }

  throw lastError instanceof Error ? lastError : new NetworkError(UNREACHABLE_SERVER_MESSAGE)
}
