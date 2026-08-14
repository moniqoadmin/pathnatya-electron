import { createHash, timingSafeEqual } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { decryptAtRest, encryptAtRest } from './hls-offline-crypto'
import { isTrustedExpired, loadTrustedTime } from './trusted-time'

/** Offline video package is valid for 10 days from download (server time). */
export const OFFLINE_VIDEO_TTL_MS = 10 * 24 * 60 * 60 * 1000

const PACKAGE_DIR_NAME = 'hls-offline'
/** Stored outside the package folder so segment blobs and hashes are not co-located. */
const INTEGRITY_FILE = 'hls-offline.integrity'
const MANIFEST_FILE = 'manifest.bin'
const SEGMENTS_DIR = 'segments'

function offlineLog(message: string, detail?: Record<string, unknown>): void {
  if (detail) {
    console.log(`[hls-offline] ${message}`, detail)
  } else {
    console.log(`[hls-offline] ${message}`)
  }
}

function shortHash(hex: string): string {
  return `${hex.slice(0, 12)}…`
}

export interface OfflineSegmentMeta {
  index: number
  durationSeconds: number
  /** Hex-encoded AES-128 IV, or null for plaintext segments. */
  iv: string | null
  file: string
}

export interface OfflineVideoManifest {
  version: 1
  sourceUrl: string
  downloadedAt: string
  expiresAt: string
  totalDurationSeconds: number
  segmentCount: number
  rewrittenPlaylist: string
  segments: OfflineSegmentMeta[]
}

export interface OfflineVideoStatus {
  available: boolean
  downloading: boolean
  completed: number
  total: number
  percent: number
  expiresAt: string | null
  downloadedAt: string | null
  bytesDownloaded: number
}

interface OfflineIntegrityManifest {
  version: 1
  algorithm: 'sha256'
  /** SHA-256 hex digests of each segment after at-rest decrypt (header stripped). */
  hashes: string[]
}

let downloadState: {
  active: boolean
  cancelled: boolean
  completed: number
  total: number
  bytesDownloaded: number
} = {
  active: false,
  cancelled: false,
  completed: 0,
  total: 0,
  bytesDownloaded: 0
}

function packageRoot(): string {
  return join(app.getPath('userData'), PACKAGE_DIR_NAME)
}

function integrityPath(): string {
  return join(app.getPath('userData'), INTEGRITY_FILE)
}

function manifestPath(): string {
  return join(packageRoot(), MANIFEST_FILE)
}

function segmentsDir(): string {
  return join(packageRoot(), SEGMENTS_DIR)
}

export function segmentFileName(index: number): string {
  // Opaque extension so the OS does not treat encrypted blobs as MPEG-TS video.
  return `segment_${String(index).padStart(3, '0')}.bin`
}

export function segmentFilePath(index: number): string {
  return join(segmentsDir(), segmentFileName(index))
}

export function hashOfflinePayload(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hashesMatch(expectedHex: string, actualHex: string): boolean {
  try {
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = Buffer.from(actualHex, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function isExpired(expiresAt: string): boolean {
  return isTrustedExpired(expiresAt)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readOfflineManifest(): Promise<OfflineVideoManifest | null> {
  try {
    await loadTrustedTime()
    const sealed = await fs.readFile(manifestPath())
    const raw = await decryptAtRest(sealed)
    const parsed = JSON.parse(raw.toString('utf8')) as OfflineVideoManifest

    if (
      parsed?.version !== 1 ||
      !parsed.sourceUrl ||
      !parsed.downloadedAt ||
      !parsed.expiresAt ||
      !parsed.rewrittenPlaylist ||
      !Array.isArray(parsed.segments) ||
      parsed.segments.length === 0
    ) {
      return null
    }

    if (isExpired(parsed.expiresAt)) {
      await deleteOfflineVideo()
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export async function writeOfflineIntegrity(hashes: string[]): Promise<void> {
  if (hashes.length === 0 || hashes.some((hash) => !/^[0-9a-f]{64}$/iu.test(hash))) {
    throw new Error('482 : Offline integrity hashes are invalid.')
  }

  const payload: OfflineIntegrityManifest = {
    version: 1,
    algorithm: 'sha256',
    hashes
  }
  const sealed = await encryptAtRest(Buffer.from(JSON.stringify(payload), 'utf8'))
  await fs.writeFile(integrityPath(), sealed)
  offlineLog('wrote integrity file', {
    path: integrityPath(),
    segmentCount: hashes.length,
    sampleHash: shortHash(hashes[0] ?? '')
  })
}

export async function readOfflineIntegrity(): Promise<OfflineIntegrityManifest | null> {
  try {
    const sealed = await fs.readFile(integrityPath())
    const raw = await decryptAtRest(sealed)
    const parsed = JSON.parse(raw.toString('utf8')) as OfflineIntegrityManifest

    if (
      parsed?.version !== 1 ||
      parsed.algorithm !== 'sha256' ||
      !Array.isArray(parsed.hashes) ||
      parsed.hashes.length === 0 ||
      parsed.hashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/iu.test(hash))
    ) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

async function allSegmentFilesPresent(manifest: OfflineVideoManifest): Promise<boolean> {
  if (!(await pathExists(integrityPath()))) {
    return false
  }

  for (const segment of manifest.segments) {
    if (!(await pathExists(join(segmentsDir(), segment.file)))) {
      return false
    }
  }
  return true
}

/**
 * After at-rest decrypt (header stripped), compare each segment to the separate
 * integrity file. Throws and wipes the package on mismatch.
 */
export async function assertOfflinePackageIntegrity(
  manifest: OfflineVideoManifest
): Promise<void> {
  offlineLog('starting full integrity check', { segmentCount: manifest.segments.length })

  const integrity = await readOfflineIntegrity()
  if (!integrity || integrity.hashes.length !== manifest.segments.length) {
    offlineLog('integrity check failed: missing/incomplete hash file', {
      expected: manifest.segments.length,
      actual: integrity?.hashes.length ?? 0
    })
    await deleteOfflineVideo()
    throw new Error('7316 : Something went wrong. Please contact admin.')
  }

  for (const segment of manifest.segments) {
    const payload = await readOfflineSegment(segment.index)
    if (!payload) {
      offlineLog('integrity check failed: segment missing after decrypt', {
        index: segment.index
      })
      await deleteOfflineVideo()
      throw new Error('294 : Something went wrong. Please contact admin.')
    }

    const actual = hashOfflinePayload(payload)
    const expected = integrity.hashes[segment.index]
    const ok = Boolean(expected && hashesMatch(expected, actual))
    offlineLog('hash compare', {
      index: segment.index,
      bytes: payload.length,
      expected: expected ? shortHash(expected) : null,
      actual: shortHash(actual),
      ok
    })

    if (!ok) {
      await deleteOfflineVideo()
      throw new Error('8651 : Offline video integrity check failed. Please contact admin.')
    }
  }

  offlineLog('full integrity check passed', { segmentCount: manifest.segments.length })
}

/** Verify a single decrypted segment against the integrity store. */
export async function assertOfflineSegmentIntegrity(
  index: number,
  decrypted: Buffer
): Promise<void> {
  const integrity = await readOfflineIntegrity()
  const expected = integrity?.hashes[index]
  const actual = hashOfflinePayload(decrypted)
  const ok = Boolean(expected && hashesMatch(expected, actual))
  offlineLog('hash compare (playback)', {
    index,
    bytes: decrypted.length,
    expected: expected ? shortHash(expected) : null,
    actual: shortHash(actual),
    ok
  })

  if (!ok) {
    await deleteOfflineVideo()
    throw new Error('537 : Something went wrong. Please contact admin.')
  }
}

export async function getValidOfflineManifest(): Promise<OfflineVideoManifest | null> {
  const manifest = await readOfflineManifest()
  if (!manifest) {
    return null
  }

  if (!(await allSegmentFilesPresent(manifest))) {
    await deleteOfflineVideo()
    return null
  }

  return manifest
}

export async function getOfflineVideoStatus(): Promise<OfflineVideoStatus> {
  const manifest = await getValidOfflineManifest()

  return {
    available: Boolean(manifest),
    downloading: downloadState.active,
    completed: downloadState.completed,
    total: downloadState.total,
    percent:
      downloadState.total > 0
        ? Math.min(100, Math.round((downloadState.completed / downloadState.total) * 100))
        : 0,
    expiresAt: manifest?.expiresAt ?? null,
    downloadedAt: manifest?.downloadedAt ?? null,
    bytesDownloaded: downloadState.bytesDownloaded
  }
}

export async function ensureOfflineDirs(): Promise<void> {
  await fs.mkdir(segmentsDir(), { recursive: true })
}

export async function writeOfflineSegment(index: number, data: Buffer): Promise<string> {
  await ensureOfflineDirs()
  const digest = hashOfflinePayload(data)
  const sealed = await encryptAtRest(data)
  await fs.writeFile(segmentFilePath(index), sealed)
  offlineLog('wrote encrypted segment', {
    index,
    plaintextBytes: data.length,
    sealedBytes: sealed.length,
    hash: shortHash(digest),
    file: segmentFileName(index)
  })
  return digest
}

export async function readOfflineSegment(index: number): Promise<Buffer | null> {
  try {
    const sealed = await fs.readFile(segmentFilePath(index))
    return await decryptAtRest(sealed)
  } catch {
    return null
  }
}

export async function writeOfflineManifest(manifest: OfflineVideoManifest): Promise<void> {
  await ensureOfflineDirs()
  const sealed = await encryptAtRest(Buffer.from(JSON.stringify(manifest), 'utf8'))
  await fs.writeFile(manifestPath(), sealed)
}

export async function deleteOfflineVideo(): Promise<void> {
  const root = packageRoot()
  if (existsSync(root)) {
    await fs.rm(root, { recursive: true, force: true })
  }

  try {
    await fs.rm(integrityPath(), { force: true })
  } catch {
    // Best-effort cleanup of the separate integrity file.
  }
}

export async function purgeExpiredOfflineVideo(): Promise<void> {
  try {
    // Legacy plaintext packages used manifest.json — wipe so users re-download encrypted.
    const legacyManifest = join(packageRoot(), 'manifest.json')
    if (await pathExists(legacyManifest)) {
      await deleteOfflineVideo()
      return
    }

    if (!(await pathExists(manifestPath()))) {
      // Orphan integrity file without a package.
      if (await pathExists(integrityPath())) {
        await deleteOfflineVideo()
      }
      return
    }

    const manifest = await readOfflineManifest()
    // null means missing/expired/corrupt — readOfflineManifest already wipes expiry;
    // wipe leftover corrupt packages that failed decrypt/parse without expiry handling.
    if (!manifest && (await pathExists(manifestPath()))) {
      await deleteOfflineVideo()
    }
  } catch {
    await deleteOfflineVideo()
  }
}

export function beginDownload(total: number): void {
  downloadState = {
    active: true,
    cancelled: false,
    completed: 0,
    total,
    bytesDownloaded: 0
  }
}

export function isDownloadCancelled(): boolean {
  return downloadState.cancelled
}

export function cancelOfflineDownload(): void {
  if (downloadState.active) {
    downloadState.cancelled = true
  }
}

export function markSegmentDownloaded(bytes: number): void {
  downloadState.completed += 1
  downloadState.bytesDownloaded += bytes
}

export function endDownload(): void {
  downloadState.active = false
  downloadState.cancelled = false
}

export function isDownloadActive(): boolean {
  return downloadState.active
}

export function currentDownloadProgress(): Pick<
  OfflineVideoStatus,
  'completed' | 'total' | 'percent' | 'bytesDownloaded' | 'downloading'
> {
  return {
    downloading: downloadState.active,
    completed: downloadState.completed,
    total: downloadState.total,
    percent:
      downloadState.total > 0
        ? Math.min(100, Math.round((downloadState.completed / downloadState.total) * 100))
        : 0,
    bytesDownloaded: downloadState.bytesDownloaded
  }
}
