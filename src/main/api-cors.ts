type HeaderValue = string | string[]
type HeaderMap = Record<string, HeaderValue>

export type HeadersReceivedDetails = {
  url: string
  method: string
  resourceType: string
  responseHeaders?: HeaderMap
}

export type HeadersReceivedResult = {
  responseHeaders: Record<string, string[]>
  statusLine?: string
}

export type WebRequestHeaderOptions = {
  apiBase: string
  csp: string | null
}

function normalizeHeaders(input?: HeaderMap): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!input) {
    return out
  }

  for (const [key, value] of Object.entries(input)) {
    out[key] = Array.isArray(value) ? value : [value]
  }

  return out
}

function setHeader(headers: Record<string, string[]>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      delete headers[key]
    }
  }
  headers[name] = [value]
}

export function isApiRequest(url: string, apiBase: string): boolean {
  return url === apiBase || url.startsWith(`${apiBase}/`) || url.startsWith(`${apiBase}?`)
}

/**
 * Chromium still enforces CORS for renderer `fetch`. The API answers OPTIONS
 * with 404 and no Access-Control-Allow-Origin, which blocks login from
 * localhost (dev) and file:// (packaged). Rewrite those responses here so the
 * desktop app can call the API without disabling webSecurity.
 */
export function nextHeadersReceived(
  details: HeadersReceivedDetails,
  options: WebRequestHeaderOptions
): HeadersReceivedResult {
  const headers = normalizeHeaders(details.responseHeaders)
  const isFrame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'

  if (options.csp && isFrame) {
    setHeader(headers, 'Content-Security-Policy', options.csp)
  }

  if (!isApiRequest(details.url, options.apiBase)) {
    return { responseHeaders: headers }
  }

  setHeader(headers, 'Access-Control-Allow-Origin', '*')
  setHeader(headers, 'Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  setHeader(
    headers,
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-App-Key, Accept'
  )
  setHeader(headers, 'Access-Control-Max-Age', '86400')

  if (details.method.toUpperCase() === 'OPTIONS') {
    return {
      responseHeaders: headers,
      statusLine: 'HTTP/1.1 204 No Content'
    }
  }

  return { responseHeaders: headers }
}
