import { createDecipheriv } from 'crypto'
import { net } from 'electron'
import { getHlsKey } from './hls-key'
import {
  OFFLINE_VIDEO_TTL_MS,
  assertOfflinePackageIntegrity,
  assertOfflineSegmentIntegrity,
  beginDownload,
  cancelOfflineDownload,
  currentDownloadProgress,
  deleteOfflineVideo,
  endDownload,
  getOfflineVideoStatus,
  getValidOfflineManifest,
  isDownloadActive,
  isDownloadCancelled,
  markSegmentDownloaded,
  readOfflineSegment,
  segmentFileName,
  writeOfflineIntegrity,
  writeOfflineManifest,
  writeOfflineSegment,
  type OfflineVideoManifest,
  type OfflineVideoStatus
} from './hls-offline'

export const DEFAULT_HLS_SOURCE =
  'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8'

/** Only these hosts may be fetched, so the renderer cannot drive arbitrary requests. */
const ALLOWED_HOSTS = new Set(['pathnatya-video-cdn.b-cdn.net'])

export const HLS_PLAYLIST_URL = 'pathnatya://hls/playlist.m3u8'
const SEGMENT_URL_PREFIX = 'pathnatya://hls/segment/'

const MAX_FETCH_ATTEMPTS = 3
/** Decrypted segments held for seek-back; ~30s each, so keep the window small. */
const MAX_CACHED_SEGMENTS = 6

export interface HlsSegment {
  index: number
  url: string
  durationSeconds: number
  /** Null when the segment is not encrypted. */
  iv: Buffer | null
}

export interface PreparedHls {
  playlistUrl: string
  totalDurationSeconds: number
  segmentCount: number
  fromOffline: boolean
  expiresAt: string | null
}

export type HlsDownloadProgress = OfflineVideoStatus

let segments: HlsSegment[] = []
let rewrittenPlaylist: string | null = null
let offlineMode = false
let offlineExpiresAt: string | null = null

const plaintextCache = new Map<number, Buffer>()
const inflightSegments = new Map<number, Promise<Buffer>>()

function assertAllowedUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('647 : Video source URL is invalid.')
  }

  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`3928 : Video source host "${url.hostname}" is not allowed.`)
  }

  return url
}

async function fetchWithRetries(url: string): Promise<Buffer> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await net.fetch(url)
      if (!response.ok) {
        throw new Error(`815 : Request failed with status ${response.status}.`)
      }

      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt >= MAX_FETCH_ATTEMPTS) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }

  const message = lastError instanceof Error ? lastError.message : `Unable to fetch ${url}.`
  throw new Error(/^\d{3,4}\s*:\s*/u.test(message) ? message : `5743 : ${message}`)
}

/** Splits an HLS tag's `KEY=VALUE` list, keeping quoted values intact. */
function parseTagAttributes(value: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gu

  for (const match of value.matchAll(pattern)) {
    const attributeValue = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2]
    attributes.set(match[1], attributeValue)
  }

  return attributes
}

function ivFromSequenceNumber(sequenceNumber: number): Buffer {
  // HLS derives a 128-bit big-endian IV from the media sequence number.
  const iv = Buffer.alloc(16)
  iv.writeBigUInt64BE(BigInt(sequenceNumber), 8)
  return iv
}

function parseIv(rawIv: string): Buffer {
  const hex = rawIv.trim().replace(/^0x/iu, '')
  if (hex.length !== 32) {
    throw new Error('268 : Playlist IV must be 128 bits.')
  }

  return Buffer.from(hex, 'hex')
}

function isTag(line: string): boolean {
  return line.startsWith('#')
}

/** Picks the highest-bandwidth rendition when handed a master playlist. */
function findBestVariant(lines: string[], baseUrl: string): string | null {
  let best: { bandwidth: number; url: string } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF:')) {
      continue
    }

    const attributes = parseTagAttributes(line.slice('#EXT-X-STREAM-INF:'.length))
    const bandwidth = Number.parseInt(attributes.get('BANDWIDTH') ?? '0', 10)

    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim()
      if (!candidate) {
        continue
      }
      if (isTag(candidate)) {
        break
      }

      if (!best || bandwidth > best.bandwidth) {
        best = { bandwidth, url: new URL(candidate, baseUrl).toString() }
      }
      break
    }
  }

  return best?.url ?? null
}

export function parseMediaPlaylist(
  playlist: string,
  baseUrl: string
): { segments: HlsSegment[]; rewritten: string } {
  const lines = playlist.split(/\r?\n/u)
  const parsed: HlsSegment[] = []
  const output: string[] = []

  let mediaSequence = 0
  let encrypted = false
  let explicitIv: Buffer | null = null
  let pendingDuration = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line) {
      continue
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0
      output.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseTagAttributes(line.slice('#EXT-X-KEY:'.length))
      const method = (attributes.get('METHOD') ?? 'NONE').toUpperCase()

      if (method === 'NONE') {
        encrypted = false
        explicitIv = null
      } else if (method === 'AES-128') {
        encrypted = true
        const rawIv = attributes.get('IV')
        explicitIv = rawIv ? parseIv(rawIv) : null
      } else {
        throw new Error(`9431 : Unsupported HLS encryption method "${method}".`)
      }

      // Dropped on purpose: segments are handed to the player already decrypted.
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0
      output.push(line)
      continue
    }

    if (isTag(line)) {
      output.push(line)
      continue
    }

    const index = parsed.length
    parsed.push({
      index,
      url: new URL(line, baseUrl).toString(),
      durationSeconds: pendingDuration,
      iv: encrypted ? (explicitIv ?? ivFromSequenceNumber(mediaSequence + index)) : null
    })
    output.push(`${SEGMENT_URL_PREFIX}${index}`)
    pendingDuration = 0
  }

  if (parsed.length === 0) {
    throw new Error('719 : Playlist does not contain any media segments.')
  }

  return { segments: parsed, rewritten: `${output.join('\n')}\n` }
}

function wipe(buffer: Buffer | null | undefined): void {
  if (buffer && buffer.length > 0) {
    buffer.fill(0)
  }
}

function cachePlaintext(index: number, plaintext: Buffer): void {
  plaintextCache.set(index, plaintext)

  // Map iterates in insertion order, so the oldest entry evicts first.
  while (plaintextCache.size > MAX_CACHED_SEGMENTS) {
    const oldest = plaintextCache.keys().next()
    if (oldest.done) {
      break
    }

    wipe(plaintextCache.get(oldest.value))
    plaintextCache.delete(oldest.value)
  }
}

function applyResolvedPlaylist(
  resolved: { segments: HlsSegment[]; rewritten: string },
  options: { fromOffline: boolean; expiresAt: string | null }
): PreparedHls {
  for (const buffer of plaintextCache.values()) {
    wipe(buffer)
  }
  plaintextCache.clear()
  inflightSegments.clear()

  segments = resolved.segments
  rewrittenPlaylist = resolved.rewritten
  offlineMode = options.fromOffline
  offlineExpiresAt = options.expiresAt

  return {
    playlistUrl: HLS_PLAYLIST_URL,
    totalDurationSeconds: segments.reduce((total, segment) => total + segment.durationSeconds, 0),
    segmentCount: segments.length,
    fromOffline: options.fromOffline,
    expiresAt: options.expiresAt
  }
}

function segmentsFromOfflineManifest(manifest: OfflineVideoManifest): HlsSegment[] {
  return manifest.segments.map((segment) => ({
    index: segment.index,
    // Offline segments are never fetched from the network.
    url: `offline://${segment.file}`,
    durationSeconds: segment.durationSeconds,
    iv: segment.iv ? Buffer.from(segment.iv, 'hex') : null
  }))
}

async function resolveRemotePlaylist(sourceUrl: string): Promise<{
  sourceUrl: string
  segments: HlsSegment[]
  rewritten: string
}> {
  const source = assertAllowedUrl(sourceUrl)

  let playlistUrl = source.toString()
  let playlistText = (await fetchWithRetries(playlistUrl)).toString('utf8')

  if (!playlistText.includes('#EXTM3U')) {
    throw new Error('3562 : Video source did not return an HLS playlist.')
  }

  const variantUrl = findBestVariant(playlistText.split(/\r?\n/u), playlistUrl)
  if (variantUrl) {
    playlistUrl = assertAllowedUrl(variantUrl).toString()
    playlistText = (await fetchWithRetries(playlistUrl)).toString('utf8')
  }

  const parsed = parseMediaPlaylist(playlistText, playlistUrl)
  return {
    sourceUrl: playlistUrl,
    segments: parsed.segments,
    rewritten: parsed.rewritten
  }
}

async function decryptPayload(index: number, payload: Buffer, iv: Buffer | null): Promise<Buffer> {
  if (!iv) {
    return payload
  }

  const decipher = createDecipheriv('aes-128-cbc', getHlsKey(), iv)

  try {
    return Buffer.concat([decipher.update(payload), decipher.final()])
  } catch {
    throw new Error(
      `681 : Unable to decrypt segment ${index}. The video key for this session does not match this video.`
    )
  } finally {
    wipe(payload)
  }
}

export async function prepareHlsVideo(sourceUrl = DEFAULT_HLS_SOURCE): Promise<PreparedHls> {
  clearPreparedHls()

  // Fail fast with a clear message if the session key was never installed.
  getHlsKey()

  const offline = await getValidOfflineManifest()
  if (offline) {
    console.log('[hls-offline] preparing offline playback — verifying package first', {
      segmentCount: offline.segmentCount,
      expiresAt: offline.expiresAt
    })
    // Decrypt each segment in memory, strip headers, then compare hashes before playback.
    await assertOfflinePackageIntegrity(offline)

    return applyResolvedPlaylist(
      {
        segments: segmentsFromOfflineManifest(offline),
        rewritten: offline.rewrittenPlaylist
      },
      { fromOffline: true, expiresAt: offline.expiresAt }
    )
  }

  console.log('[hls-offline] no offline package — loading online source')

  try {
    const remote = await resolveRemotePlaylist(sourceUrl)
    return applyResolvedPlaylist(
      { segments: remote.segments, rewritten: remote.rewritten },
      { fromOffline: false, expiresAt: null }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '4276 : Unable to prepare video.'
    throw new Error(
      `${message} Download the video while online to watch offline for 7 days.`
    )
  }
}

export function getRewrittenPlaylist(): string {
  if (!rewrittenPlaylist) {
    throw new Error('804 : HLS video is not prepared.')
  }

  return rewrittenPlaylist
}

export async function getDecryptedSegment(index: number): Promise<Buffer> {
  const segment = segments[index]
  if (!segment) {
    throw new Error(`5196 : Unknown HLS segment ${index}.`)
  }

  const cached = plaintextCache.get(index)
  if (cached) {
    return cached
  }

  const inflight = inflightSegments.get(index)
  if (inflight) {
    return inflight
  }

  const load = (async () => {
    // Only read from disk once the package is complete; an in-progress download
    // leaves partially written files that would decrypt to garbage.
    const useOffline = offlineMode || segment.url.startsWith('offline://')
    let payload = useOffline ? await readOfflineSegment(index) : null

    if (!payload) {
      if (useOffline) {
        throw new Error('2637 : Something went wrong. Please contact admin.')
      }

      payload = await fetchWithRetries(segment.url)
    } else {
      await assertOfflineSegmentIntegrity(index, payload)
    }

    const plaintext = await decryptPayload(index, payload, segment.iv)
    cachePlaintext(index, plaintext)
    return plaintext
  })()

  const tracked = load.finally(() => {
    inflightSegments.delete(index)
  })

  inflightSegments.set(index, tracked)
  return tracked
}

export async function downloadHlsVideoForOffline(
  onProgress: (progress: HlsDownloadProgress) => void,
  sourceUrl = DEFAULT_HLS_SOURCE
): Promise<OfflineVideoStatus> {
  if (isDownloadActive()) {
    throw new Error('938 : A download is already in progress.')
  }

  getHlsKey()

  const remote = await resolveRemotePlaylist(sourceUrl)
  beginDownload(remote.segments.length)

  const emit = async (): Promise<void> => {
    onProgress(await getOfflineVideoStatus())
  }

  await emit()

  try {
    // Wipe any previous package so a cancelled download cannot leave a partial valid state.
    await deleteOfflineVideo()

    const hashes: string[] = new Array(remote.segments.length)

    for (const segment of remote.segments) {
      if (isDownloadCancelled()) {
        await deleteOfflineVideo()
        throw new Error('1472 : Download cancelled.')
      }

      const payload = await fetchWithRetries(segment.url)
      hashes[segment.index] = await writeOfflineSegment(segment.index, payload)
      markSegmentDownloaded(payload.length)
      await emit()
    }

    if (isDownloadCancelled()) {
      await deleteOfflineVideo()
      throw new Error('625 : Download cancelled.')
    }

    const downloadedAt = new Date()
    const expiresAt = new Date(downloadedAt.getTime() + OFFLINE_VIDEO_TTL_MS)

    const manifest: OfflineVideoManifest = {
      version: 1,
      sourceUrl: remote.sourceUrl,
      downloadedAt: downloadedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      totalDurationSeconds: remote.segments.reduce(
        (total, segment) => total + segment.durationSeconds,
        0
      ),
      segmentCount: remote.segments.length,
      rewrittenPlaylist: remote.rewritten,
      segments: remote.segments.map((segment) => ({
        index: segment.index,
        durationSeconds: segment.durationSeconds,
        iv: segment.iv ? segment.iv.toString('hex') : null,
        file: segmentFileName(segment.index)
      }))
    }

    // Hashes live outside the package folder; segments stay under hls-offline/.
    await writeOfflineIntegrity(hashes)
    await writeOfflineManifest(manifest)
    await assertOfflinePackageIntegrity(manifest)

    // Switch live playback to the offline package so subsequent seeks stay local.
    applyResolvedPlaylist(
      {
        segments: segmentsFromOfflineManifest(manifest),
        rewritten: manifest.rewrittenPlaylist
      },
      { fromOffline: true, expiresAt: manifest.expiresAt }
    )

    return getOfflineVideoStatus()
  } catch (error) {
    if (isDownloadCancelled()) {
      await deleteOfflineVideo()
    }
    throw error
  } finally {
    endDownload()
    await emit()
  }
}

export function cancelHlsOfflineDownload(): void {
  cancelOfflineDownload()
}

export function clearPreparedHls(): void {
  for (const buffer of plaintextCache.values()) {
    wipe(buffer)
  }
  plaintextCache.clear()
  inflightSegments.clear()
  segments = []
  rewrittenPlaylist = null
  offlineMode = false
  offlineExpiresAt = null
}

export { getOfflineVideoStatus, deleteOfflineVideo, currentDownloadProgress }
