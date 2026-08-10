import { describe, expect, it } from 'vitest'
import { isScreenSizeTooSmall } from './platform-guard'

describe('isScreenSizeTooSmall', () => {
  it('allows common laptop resolutions', () => {
    expect(isScreenSizeTooSmall(1366, 768)).toBe(false)
    expect(isScreenSizeTooSmall(1920, 1080)).toBe(false)
    expect(isScreenSizeTooSmall(1280, 800)).toBe(false)
    expect(isScreenSizeTooSmall(1280, 720)).toBe(false)
  })

  it('blocks phone-sized screens in landscape and portrait', () => {
    expect(isScreenSizeTooSmall(844, 390)).toBe(true)
    expect(isScreenSizeTooSmall(390, 844)).toBe(true)
    expect(isScreenSizeTooSmall(412, 915)).toBe(true)
  })

  it('blocks small / low-res panels', () => {
    expect(isScreenSizeTooSmall(1024, 600)).toBe(true)
    expect(isScreenSizeTooSmall(960, 640)).toBe(true)
    expect(isScreenSizeTooSmall(1024, 768)).toBe(true)
  })
})
