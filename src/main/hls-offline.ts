import { createHash, timingSafeEqual } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { app, net } from 'electron'
import { UNIQUE_MANIFEST_NAME } from '../shared/unique-asar-name'
import { decryptAtRest, encryptAtRest } from './hls-offline-crypto'
import { readSealedManifestBlob, writeSealedManifestBlob } from './hls-offline-db'
import { getHlsAppConfiguration } from './hls-config'
import { isTrustedExpired, loadTrustedTime } from './trusted-time'

/** Prefer keeping a downloaded package when the machine cannot re-fetch it. */
function isAppOffline(): boolean {
  try {
    return net.isOnline() === false
  } catch {
    return false
  }
}

/**
 * Wipe the offline package only when online. Offline wipes strand the user until
 * they can download again (e.g. logout → status check → decrypt glitch).
 */
async function deleteOfflineVideoIfOnline(reason: string): Promise<void> {
  if (isAppOffline()) {
    offlineLog('skipping offline-package wipe while offline', { reason })
    return
  }

  await deleteOfflineVideo()
}

/**
 * Offline package expiry: earlier of the stamped download expiry and `END_DATE`
 * from app configuration, so the server can shorten access without a re-download.
 */
function effectiveExpiresAt(stamped: string): string {
  const configured = getHlsAppConfiguration()?.endDate
  if (!configured) {
    return stamped
  }

  const stampedMs = Date.parse(stamped)
  const configuredMs = Date.parse(configured)
  if (Number.isNaN(configuredMs)) {
    return stamped
  }

  if (Number.isNaN(stampedMs) || configuredMs < stampedMs) {
    return configured
  }

  return stamped
}

const PACKAGE_DIR_NAME = 'hls-offline'
/** Stored outside the package folder so segment blobs and hashes are not co-located. */
const INTEGRITY_FILE = 'hls-offline.integrity'
const MANIFEST_FILE = UNIQUE_MANIFEST_NAME
const SEGMENTS_DIR = 'segments'
/** Pre-SQLite / pre-rename basenames; wipe so users re-download under the UUID DB. */
const LEGACY_MANIFEST_FILES = [
  'manifest.json',
  'manifest.bin',
  'c8e2b4a1-6f3d-4c9a-b715-9e0a3d7f2c48.bin'
] as const

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
  return isTrustedExpired(effectiveExpiresAt(expiresAt))
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Decrypt an at-rest blob. On failure (wrong device MAC, tamper, bad header)
 * wipe the whole offline package so it cannot be reused on another machine —
 * but never while offline, so logout / status checks cannot erase a download
 * the user cannot replace yet.
 */
async function decryptSealedBlobOrWipe(sealed: Buffer, sourceLabel: string): Promise<Buffer> {
  try {
    return await decryptAtRest(sealed)
  } catch (error) {
    offlineLog('at-rest decrypt failed', {
      file: sourceLabel,
      message: error instanceof Error ? error.message : String(error),
      wipe: !isAppOffline()
    })
    await deleteOfflineVideoIfOnline('at-rest decrypt failed')
    throw error
  }
}

async function decryptSealedFileOrWipe(filePath: string): Promise<Buffer> {
  const sealed = await fs.readFile(filePath)
  return decryptSealedBlobOrWipe(sealed, filePath)
}

export async function readOfflineManifest(): Promise<OfflineVideoManifest | null> {
  try {
    await loadTrustedTime()
    if (!(await pathExists(manifestPath()))) {
      return null
    }

    let sealed: Buffer | null
    try {
      sealed = await readSealedManifestBlob(manifestPath())
    } catch (error) {
      offlineLog('manifest db decrypt/read failed', {
        file: manifestPath(),
        message: error instanceof Error ? error.message : String(error)
      })
      await deleteOfflineVideoIfOnline('manifest db decrypt/read failed')
      return null
    }

    if (!sealed) {
      await deleteOfflineVideoIfOnline('manifest blob missing')
      return null
    }

    const raw = await decryptSealedBlobOrWipe(sealed, manifestPath())
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
      await deleteOfflineVideoIfOnline('manifest invalid')
      return null
    }

    if (isExpired(parsed.expiresAt)) {
      await deleteOfflineVideo()
      return null
    }

    return {
      ...parsed,
      expiresAt: effectiveExpiresAt(parsed.expiresAt)
    }
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
    if (!(await pathExists(integrityPath()))) {
      return null
    }

    const raw = await decryptSealedFileOrWipe(integrityPath())
    const parsed = JSON.parse(raw.toString('utf8')) as OfflineIntegrityManifest

    if (
      parsed?.version !== 1 ||
      parsed.algorithm !== 'sha256' ||
      !Array.isArray(parsed.hashes) ||
      parsed.hashes.length === 0 ||
      parsed.hashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/iu.test(hash))
    ) {
      await deleteOfflineVideoIfOnline('integrity file invalid')
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
    await deleteOfflineVideoIfOnline('integrity missing/incomplete')
    throw new Error('7316 : Something went wrong. Please contact admin.')
  }

  for (const segment of manifest.segments) {
    const payload = await readOfflineSegment(segment.index)
    if (!payload) {
      offlineLog('integrity check failed: segment missing after decrypt', {
        index: segment.index
      })
      await deleteOfflineVideoIfOnline('segment missing after decrypt')
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
      await deleteOfflineVideoIfOnline('segment hash mismatch')
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
    await deleteOfflineVideoIfOnline('playback segment hash mismatch')
    throw new Error('537 : Something went wrong. Please contact admin.')
  }
}

export async function getValidOfflineManifest(): Promise<OfflineVideoManifest | null> {
  const manifest = await readOfflineManifest()
  if (!manifest) {
    return null
  }

  if (!(await allSegmentFilesPresent(manifest))) {
    await deleteOfflineVideoIfOnline('segment files incomplete')
    return null
  }

  return manifest
}

/**
 * True when a downloaded offline package is on disk. Does not decrypt, expire,
 * or delete anything — used only to decide whether the 2-day online check-in
 * applies.
 */
export async function hasOfflineVideoPackage(): Promise<boolean> {
  return pathExists(manifestPath())
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
  const path = segmentFilePath(index)
  if (!(await pathExists(path))) {
    return null
  }

  try {
    return await decryptSealedFileOrWipe(path)
  } catch {
    return null
  }
}

export async function writeOfflineManifest(manifest: OfflineVideoManifest): Promise<void> {
  await ensureOfflineDirs()
  const sealed = await encryptAtRest(Buffer.from(JSON.stringify(manifest), 'utf8'))
  await writeSealedManifestBlob(manifestPath(), sealed)
}

/** Windows keeps brief locks on files the app just read; a couple of retries clears them. */
async function removePath(target: string, recursive = false): Promise<void> {
  let lastError: unknown

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await fs.rm(target, { force: true, recursive })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt))
    }
  }

  throw lastError
}

export async function deleteOfflineVideo(): Promise<void> {
  // The manifest DB is what makes a package look playable, so it goes first: if a
  // later step fails the leftovers are inert instead of metadata promising segments
  // that are no longer on disk.
  let manifestError: unknown = null
  try {
    await removePath(manifestPath())
  } catch (error) {
    manifestError = error
  }

  try {
    await removePath(integrityPath())
  } catch {
    // Best-effort cleanup of the separate integrity file.
  }

  let rootError: unknown = null
  const root = packageRoot()
  if (existsSync(root)) {
    try {
      await removePath(root, true)
    } catch (error) {
      rootError = error
    }
  }

  // Surfaced to the renderer, which reads EPERM on hls-offline as tampering.
  const failure = manifestError ?? rootError
  if (failure) {
    throw failure
  }
}

/** Exported for playback paths that should not erase a package while offline. */
export async function deleteOfflineVideoUnlessOffline(reason: string): Promise<void> {
  await deleteOfflineVideoIfOnline(reason)
}

export async function purgeExpiredOfflineVideo(): Promise<void> {
  try {
    // Legacy file-based manifests — wipe so users re-download into the UUID SQLite DB.
    for (const legacyName of LEGACY_MANIFEST_FILES) {
      if (await pathExists(join(packageRoot(), legacyName))) {
        await deleteOfflineVideo()
        return
      }
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
    if (!manifest) {
      if (await pathExists(manifestPath())) {
        await deleteOfflineVideo()
      }
      return
    }

    // Metadata that outlived its segments (tamper wipe, interrupted download, locked
    // file during cleanup) would otherwise fail the integrity check at login and leave
    // the user on the contact-admin error with no way back.
    if (!(await allSegmentFilesPresent(manifest))) {
      offlineLog('purging package with missing segments or integrity file', {
        segmentCount: manifest.segments.length
      })
      await deleteOfflineVideo()
      return
    }

    const integrity = await readOfflineIntegrity()
    if (!integrity || integrity.hashes.length !== manifest.segments.length) {
      offlineLog('purging package with incomplete integrity hashes', {
        expected: manifest.segments.length,
        actual: integrity?.hashes.length ?? 0
      })
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
