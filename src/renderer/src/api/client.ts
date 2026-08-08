import { APP_KEY, API_BASE } from './config'
import { decryptPayload, encryptPayload } from './payload-crypto'

export type ApiFetchOptions = RequestInit & {
  json?: unknown
  authToken?: string
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const message = (data as { message: unknown }).message
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }
  return fallback
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { json, authToken, headers: initHeaders, body: initBody, ...rest } = options
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

  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers, body })
  const contentType = res.headers.get('content-type') ?? ''

  // Binary downloads (template) — no decrypt
  if (contentType.includes('spreadsheet') || contentType.includes('octet-stream')) {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return (await res.blob()) as T
  }

  if (res.status === 204) {
    return undefined as T
  }

  const envelope = await res.json()
  if (typeof envelope?.payload !== 'string') {
    throw new Error('Expected encrypted payload response')
  }

  const data = await decryptPayload<T>(envelope.payload)
  if (!res.ok) {
    throw Object.assign(new Error(errorMessage(data, 'API error')), {
      status: res.status,
      data
    })
  }

  return data
}
