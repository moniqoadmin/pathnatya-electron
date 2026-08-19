import { describe, expect, it } from 'vitest'
import { isNetworkError, NetworkError } from './network'
import { userError } from './user-error'

const UNREACHABLE_SERVER = userError(
  503,
  'Unable to reach the server. Check your connection and try again.'
)
const REQUEST_TIMED_OUT = userError(
  408,
  'Request timed out. Check your connection and try again.'
)

describe('isNetworkError', () => {
  it('matches typed NetworkError even when the coded message has no network keywords', () => {
    expect(UNREACHABLE_SERVER).toBe(
      '503 : Unable to reach the server. Check your connection and try again.'
    )
    expect(REQUEST_TIMED_OUT).toBe(
      '408 : Request timed out. Check your connection and try again.'
    )

    expect(isNetworkError(new NetworkError(UNREACHABLE_SERVER))).toBe(true)
    expect(isNetworkError(new NetworkError(REQUEST_TIMED_OUT))).toBe(true)
  })

  it('does not treat the same coded strings on a plain Error as a network failure', () => {
    expect(isNetworkError(new Error(UNREACHABLE_SERVER))).toBe(false)
    expect(isNetworkError(new Error(REQUEST_TIMED_OUT))).toBe(false)
    expect(
      isNetworkError(new Error(userError(965, 'Unable to verify phone number. Please try again.')))
    ).toBe(false)
  })

  it('still matches TypeError and fetch-style messages', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('network request failed'))).toBe(true)
  })
})
