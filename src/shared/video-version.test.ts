import { describe, expect, it } from 'vitest'
import {
  isNewerVideoVersion,
  majorVersion,
  parseVideoVersion
} from './video-version'

describe('video-version', () => {
  it('parses a non-empty version string', () => {
    expect(parseVideoVersion(' 2.0.0 ')).toBe('2.0.0')
    expect(parseVideoVersion('')).toBeNull()
    expect(parseVideoVersion(2)).toBeNull()
    expect(parseVideoVersion(undefined)).toBeNull()
  })

  it('reads the major segment', () => {
    expect(majorVersion('1.0.0')).toBe(1)
    expect(majorVersion('v2.4.1')).toBe(2)
    expect(majorVersion('not-a-version')).toBe(0)
  })

  it('detects when latest is a newer major than current', () => {
    expect(isNewerVideoVersion('2.0.0', '1.0.0')).toBe(true)
    expect(isNewerVideoVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVideoVersion('2.0.0', '2.0.0')).toBe(false)
    expect(isNewerVideoVersion('1.2.0', '1.0.0')).toBe(false)
    expect(isNewerVideoVersion('2.0.1', '2.0.0')).toBe(false)
    expect(isNewerVideoVersion('1.0.0', '2.0.0')).toBe(false)
  })
})
