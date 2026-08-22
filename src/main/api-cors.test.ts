import { describe, expect, it } from 'vitest'
import { isApiRequest, nextHeadersReceived } from './api-cors'

const API_BASE = 'https://yuvavibhag.satvichardarshan.org.in/api'
const CSP = "default-src 'self'"

describe('isApiRequest', () => {
  it('matches the API base, subpaths, and query strings', () => {
    expect(isApiRequest(`${API_BASE}`, API_BASE)).toBe(true)
    expect(isApiRequest(`${API_BASE}/accounts/check-phone`, API_BASE)).toBe(true)
    expect(isApiRequest(`${API_BASE}?q=1`, API_BASE)).toBe(true)
  })

  it('does not match a different host or a prefix collision', () => {
    expect(isApiRequest('https://cdn.example.test/api/accounts/check-phone', API_BASE)).toBe(false)
    expect(isApiRequest('https://yuvavibhag.satvichardarshan.org.in/api-internal', API_BASE)).toBe(
      false
    )
    expect(isApiRequest('https://speed.cloudflare.com/__down', API_BASE)).toBe(false)
  })
})

describe('nextHeadersReceived', () => {
  it('adds CORS headers to API responses used by renderer fetch', () => {
    const result = nextHeadersReceived(
      {
        url: `${API_BASE}/accounts/check-phone`,
        method: 'POST',
        resourceType: 'xhr',
        responseHeaders: {
          'Content-Type': ['application/json']
        }
      },
      { apiBase: API_BASE, csp: CSP }
    )

    expect(result.statusLine).toBeUndefined()
    expect(result.responseHeaders['Access-Control-Allow-Origin']).toEqual(['*'])
    expect(result.responseHeaders['Access-Control-Allow-Headers']?.[0]).toContain('X-App-Key')
    expect(result.responseHeaders['Access-Control-Allow-Headers']?.[0]).toContain('Authorization')
    expect(result.responseHeaders['Content-Type']).toEqual(['application/json'])
    expect(result.responseHeaders['Content-Security-Policy']).toBeUndefined()
  })

  it('turns API OPTIONS 404 preflights into 204 with CORS headers', () => {
    const result = nextHeadersReceived(
      {
        url: `${API_BASE}/accounts/check-phone`,
        method: 'OPTIONS',
        resourceType: 'xhr',
        responseHeaders: {
          'Content-Type': ['application/json']
        }
      },
      { apiBase: API_BASE, csp: null }
    )

    expect(result.statusLine).toBe('HTTP/1.1 204 No Content')
    expect(result.responseHeaders['Access-Control-Allow-Origin']).toEqual(['*'])
    expect(result.responseHeaders['Access-Control-Allow-Methods']?.[0]).toContain('POST')
  })

  it('replaces an existing CORS origin so the renderer origin is not rejected', () => {
    const result = nextHeadersReceived(
      {
        url: `${API_BASE}/accounts/login`,
        method: 'POST',
        resourceType: 'xhr',
        responseHeaders: {
          'access-control-allow-origin': ['https://web.example.test']
        }
      },
      { apiBase: API_BASE, csp: null }
    )

    expect(result.responseHeaders['access-control-allow-origin']).toBeUndefined()
    expect(result.responseHeaders['Access-Control-Allow-Origin']).toEqual(['*'])
  })

  it('pins CSP on document frames and skips it on API calls', () => {
    const frame = nextHeadersReceived(
      {
        url: 'file:///index.html',
        method: 'GET',
        resourceType: 'mainFrame',
        responseHeaders: {}
      },
      { apiBase: API_BASE, csp: CSP }
    )
    expect(frame.responseHeaders['Content-Security-Policy']).toEqual([CSP])
    expect(frame.responseHeaders['Access-Control-Allow-Origin']).toBeUndefined()

    const noCsp = nextHeadersReceived(
      {
        url: 'file:///index.html',
        method: 'GET',
        resourceType: 'mainFrame',
        responseHeaders: {}
      },
      { apiBase: API_BASE, csp: null }
    )
    expect(noCsp.responseHeaders['Content-Security-Policy']).toBeUndefined()
  })
})
