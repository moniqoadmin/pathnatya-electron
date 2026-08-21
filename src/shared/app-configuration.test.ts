import { describe, expect, it } from 'vitest'
import { parseAppConfigurationsPayload, parseVideoFileNames, parseVideoScenes } from './app-configuration'

const SAMPLE = [
  {
    id: 1,
    videoConfig: {
      DEFAULT_HLS_SOURCE: 'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8',
      ALLOWED_HOSTS: ['pathnatya-video-cdn.b-cdn.net']
    },
    videoFiles: []
  }
]

describe('parseAppConfigurationsPayload', () => {
  it('reads DEFAULT_HLS_SOURCE and ALLOWED_HOSTS from the API array', () => {
    const config = parseAppConfigurationsPayload(SAMPLE)

    expect(config.hlsSource).toBe(
      'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8'
    )
    expect(config.allowedHosts).toContain('pathnatya-video-cdn.b-cdn.net')
    expect(config.videoFiles).toEqual([])
    expect(config.videoScenes).toEqual([])
  })

  it('adds the source hostname when ALLOWED_HOSTS is omitted', () => {
    const config = parseAppConfigurationsPayload({
      videoConfig: {
        DEFAULT_HLS_SOURCE: 'https://cdn.example.com/show/playlist.m3u8'
      },
      videoFiles: ['clip.mp4']
    })

    expect(config.allowedHosts).toEqual(['cdn.example.com'])
    expect(config.videoFiles).toEqual(['clip.mp4'])
  })

  it('merges videoFiles across rows and accepts name objects', () => {
    const config = parseAppConfigurationsPayload([
      {
        videoConfig: {
          DEFAULT_HLS_SOURCE: 'https://cdn.example.com/a/playlist.m3u8',
          ALLOWED_HOSTS: ['cdn.example.com']
        },
        videoFiles: ['alpha.bin']
      },
      {
        videoConfig: {
          DEFAULT_HLS_SOURCE: 'https://cdn.example.com/b/playlist.m3u8'
        },
        videoFiles: [{ name: 'folder/beta.mp4' }, { filename: 'gamma.ts' }]
      }
    ])

    expect(config.hlsSource).toBe('https://cdn.example.com/a/playlist.m3u8')
    expect(config.videoFiles).toEqual(['alpha.bin', 'beta.mp4', 'gamma.ts'])
  })

  it('accepts the stored IPC shape', () => {
    const config = parseAppConfigurationsPayload({
      hlsSource: 'https://other.example/v/playlist.m3u8',
      allowedHosts: ['other.example'],
      videoFiles: ['secret.asar']
    })

    expect(config.hlsSource).toBe('https://other.example/v/playlist.m3u8')
    expect(config.allowedHosts).toEqual(['other.example'])
    expect(config.videoFiles).toEqual(['secret.asar'])
    expect(config.videoScenes).toEqual([])
  })

  it('rejects http sources and empty payloads', () => {
    expect(() =>
      parseAppConfigurationsPayload({
        videoConfig: { DEFAULT_HLS_SOURCE: 'http://cdn.example.com/playlist.m3u8' }
      })
    ).toThrow(/HTTPS/u)

    expect(() => parseAppConfigurationsPayload([])).toThrow(/video source/u)
  })

  it('reads VIDEO_SCENES without failing when the key is missing', () => {
    const withScenes = parseAppConfigurationsPayload({
      videoConfig: {
        DEFAULT_HLS_SOURCE: 'https://cdn.example.com/show/playlist.m3u8',
        VIDEO_SCENES: [
          { scene: 1, label: 'Scene 1', time: '1.58' },
          { scene: 2, label: 'Scene 2', time: '5.00' }
        ]
      }
    })

    expect(withScenes.videoScenes).toEqual([
      { scene: 1, label: 'Scene 1', time: '1.58' },
      { scene: 2, label: 'Scene 2', time: '5.00' }
    ])

    const withoutScenes = parseAppConfigurationsPayload({
      videoConfig: {
        DEFAULT_HLS_SOURCE: 'https://cdn.example.com/show/playlist.m3u8'
      }
    })
    expect(withoutScenes.videoScenes).toEqual([])
  })
})

describe('parseVideoFileNames', () => {
  it('uses basenames from paths and object fields', () => {
    expect(
      parseVideoFileNames([
        'Copies\\video.mp4',
        { file: '/tmp/segment_000.bin' },
        { path: 'nested/clip.ts' },
        '',
        12
      ])
    ).toEqual(['video.mp4', 'segment_000.bin', 'clip.ts'])
  })
})

describe('parseVideoScenes', () => {
  it('accepts object rows, clock strings, and skips invalid entries', () => {
    expect(
      parseVideoScenes([
        { scene: 1, label: 'Opening', time: '1.58' },
        '5.00',
        { time: 'not-a-clock' },
        12,
        { scene: 4, time: '13:00' }
      ])
    ).toEqual([
      { scene: 1, label: 'Opening', time: '1.58' },
      { scene: 2, label: 'Scene 2', time: '5.00' },
      { scene: 4, label: 'Scene 4', time: '13:00' }
    ])
  })

  it('returns an empty list when VIDEO_SCENES is missing or unusable', () => {
    expect(parseVideoScenes(undefined)).toEqual([])
    expect(parseVideoScenes(null)).toEqual([])
    expect(parseVideoScenes('')).toEqual([])
    expect(parseVideoScenes('not-json')).toEqual([])
    expect(parseVideoScenes({ time: '1.58' })).toEqual([])
  })
})
