import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/** Offline video package is valid for 7 days from download. */
export const OFFLINE_VIDEO_TTL_MS = 7 * 24 * 60 * 60 * 1000

const PACKAGE_DIR_NAME = 'hls-offline'
const MANIFEST_FILE = 'manifest.json'
const SEGMENTS_DIR = 'segments'

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

function manifestPath(): string {
  return join(packageRoot(), MANIFEST_FILE)
}

function segmentsDir(): string {
  return join(packageRoot(), SEGMENTS_DIR)
}

export function segmentFileName(index: number): string {
  return `segment_${String(index).padStart(3, '0')}.ts`
}

export function segmentFilePath(index: number): string {
  return join(segmentsDir(), segmentFileName(index))
}

function isExpired(expiresAt: string): boolean {
  const expiresMs = Date.parse(expiresAt)
  return Number.isNaN(expiresMs) || Date.now() >= expiresMs
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
    const raw = await fs.readFile(manifestPath(), 'utf8')
    const parsed = JSON.parse(raw) as OfflineVideoManifest

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

async function allSegmentFilesPresent(manifest: OfflineVideoManifest): Promise<boolean> {
  for (const segment of manifest.segments) {
    if (!(await pathExists(join(segmentsDir(), segment.file)))) {
      return false
    }
  }
  return true
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

export async function writeOfflineSegment(index: number, data: Buffer): Promise<void> {
  await ensureOfflineDirs()
  await fs.writeFile(segmentFilePath(index), data)
}

export async function readOfflineSegment(index: number): Promise<Buffer | null> {
  try {
    return await fs.readFile(segmentFilePath(index))
  } catch {
    return null
  }
}

export async function writeOfflineManifest(manifest: OfflineVideoManifest): Promise<void> {
  await ensureOfflineDirs()
  await fs.writeFile(manifestPath(), JSON.stringify(manifest), 'utf8')
}

export async function deleteOfflineVideo(): Promise<void> {
  const root = packageRoot()
  if (!existsSync(root)) {
    return
  }

  await fs.rm(root, { recursive: true, force: true })
}

export async function purgeExpiredOfflineVideo(): Promise<void> {
  try {
    const raw = await fs.readFile(manifestPath(), 'utf8')
    const parsed = JSON.parse(raw) as OfflineVideoManifest
    if (!parsed?.expiresAt || isExpired(parsed.expiresAt)) {
      await deleteOfflineVideo()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // Corrupt package — wipe it.
      await deleteOfflineVideo()
    }
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
