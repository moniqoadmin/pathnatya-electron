import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd()
  }
}))

const { parseMediaPlaylist } = await import('./hls-service')

const BASE_URL = 'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8'

const ENCRYPTED_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:34',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="secret.key",IV=0x00000000000000000000000000000000',
  '#EXTINF:30.016667,',
  'segment_000.ts',
  '#EXTINF:7.133333,',
  'segment_001.ts',
  '#EXT-X-ENDLIST',
  ''
].join('\n')

describe('parseMediaPlaylist', () => {
  it('resolves segment URLs against the playlist URL', () => {
    const { segments } = parseMediaPlaylist(ENCRYPTED_PLAYLIST, BASE_URL)

    expect(segments.map((segment) => segment.url)).toEqual([
      'https://pathnatya-video-cdn.b-cdn.net/video-001/segment_000.ts',
      'https://pathnatya-video-cdn.b-cdn.net/video-001/segment_001.ts'
    ])
    expect(segments.map((segment) => segment.durationSeconds)).toEqual([30.016667, 7.133333])
  })

  it('drops the key tag and points segments at the local protocol', () => {
    const { rewritten } = parseMediaPlaylist(ENCRYPTED_PLAYLIST, BASE_URL)

    expect(rewritten).not.toContain('#EXT-X-KEY')
    expect(rewritten).not.toContain('secret.key')
    expect(rewritten).toContain('pathnatya://hls/segment/0')
    expect(rewritten).toContain('pathnatya://hls/segment/1')
    expect(rewritten).not.toContain('segment_000.ts')

    // Tags the player needs must survive the rewrite.
    expect(rewritten).toContain('#EXTM3U')
    expect(rewritten).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(rewritten).toContain('#EXTINF:30.016667,')
    expect(rewritten).toContain('#EXT-X-ENDLIST')
  })

  it('uses the IV declared by the key tag for every segment', () => {
    const playlist = ENCRYPTED_PLAYLIST.replace(
      'IV=0x00000000000000000000000000000000',
      'IV=0x0102030405060708090a0b0c0d0e0f10'
    )

    const { segments } = parseMediaPlaylist(playlist, BASE_URL)

    for (const segment of segments) {
      expect(segment.iv?.toString('hex')).toBe('0102030405060708090a0b0c0d0e0f10')
    }
  })

  it('derives the IV from the media sequence number when none is declared', () => {
    const playlist = ENCRYPTED_PLAYLIST.replace(
      ',IV=0x00000000000000000000000000000000',
      ''
    ).replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:5')

    const { segments } = parseMediaPlaylist(playlist, BASE_URL)

    expect(segments[0].iv?.toString('hex')).toBe('00000000000000000000000000000005')
    expect(segments[1].iv?.toString('hex')).toBe('00000000000000000000000000000006')
  })

  it('marks segments as plaintext when encryption is NONE', () => {
    const playlist = ENCRYPTED_PLAYLIST.replace(
      '#EXT-X-KEY:METHOD=AES-128,URI="secret.key",IV=0x00000000000000000000000000000000',
      '#EXT-X-KEY:METHOD=NONE'
    )

    const { segments } = parseMediaPlaylist(playlist, BASE_URL)

    expect(segments.every((segment) => segment.iv === null)).toBe(true)
  })

  it('rejects encryption methods it cannot decrypt', () => {
    const playlist = ENCRYPTED_PLAYLIST.replace('METHOD=AES-128', 'METHOD=SAMPLE-AES')

    expect(() => parseMediaPlaylist(playlist, BASE_URL)).toThrow(/SAMPLE-AES/u)
  })

  it('rejects a playlist with no segments', () => {
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-ENDLIST'].join('\n')

    expect(() => parseMediaPlaylist(playlist, BASE_URL)).toThrow(/media segments/u)
  })
})
