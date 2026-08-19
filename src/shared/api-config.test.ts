import { describe, expect, it } from 'vitest'
import { API_BASE } from './api-config'

describe('API_BASE', () => {
  it('reveals a https API origin from the stored cipher', () => {
    const url = new URL(API_BASE)
    expect(url.protocol).toBe('https:')
    expect(url.pathname).toBe('/api')
    expect(url.hostname.length).toBeGreaterThan(0)
  })
})
