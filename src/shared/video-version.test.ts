import { describe, expect, it } from 'vitest'
import packageJson from '../../package.json'
import {
  PROJECT_VIDEO_VERSION,
  isVideoMajorVersionChange,
  majorVersion,
  parseVideoVersion
} from './video-version'

describe('video-version', () => {
  it('keeps package.json videoVersion in sync with PROJECT_VIDEO_VERSION', () => {
    expect(packageJson.videoVersion).toBe(PROJECT_VIDEO_VERSION)
  })

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

  it('detects a major video version change', () => {
    expect(isVideoMajorVersionChange('1.0.0', '2.0.0')).toBe(true)
    expect(isVideoMajorVersionChange('1.9.9', '2.0.0')).toBe(true)
    expect(isVideoMajorVersionChange('1.0.0', '1.2.0')).toBe(false)
    expect(isVideoMajorVersionChange('2.0.0', '2.0.1')).toBe(false)
  })
})
