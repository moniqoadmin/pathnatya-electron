/**
 * Process-lifetime in-RAM HLS package for online-only accounts.
 * Segments use the same at-rest seal as offline (`encryptAtRest` / PNOF AES-256-GCM)
 * but stay in main-process memory only — never written to disk or temp.
 */

import { decryptAtRest, encryptAtRest } from './hls-offline-crypto'

export interface MemorySegmentMeta {
  index: number
  durationSeconds: number
  /** Hex-encoded AES-128 IV, or null for plaintext segments. */
  iv: string | null
}

export interface MemoryVideoPackage {
  sourceUrl: string
  downloadedAt: string
  totalDurationSeconds: number
  segmentCount: number
  rewrittenPlaylist: string
  segments: MemorySegmentMeta[]
  /** At-rest sealed segment blobs (same format as offline `segment_NNN.bin`). */
  payloads: Buffer[]
}

export interface MemoryVideoStatus {
  available: boolean
  downloading: boolean
  completed: number
  total: number
  percent: number
  expiresAt: string | null
  downloadedAt: string | null
  bytesDownloaded: number
}

let packageState: MemoryVideoPackage | null = null

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

function wipe(buffer: Buffer | null | undefined): void {
  if (buffer && buffer.length > 0) {
    buffer.fill(0)
  }
}

export function getMemoryVideoPackage(): MemoryVideoPackage | null {
  return packageState
}

export function hasMemoryVideo(): boolean {
  return packageState !== null && packageState.payloads.length === packageState.segmentCount
}

export function getMemoryVideoStatus(): MemoryVideoStatus {
  if (downloadState.active) {
    const percent =
      downloadState.total > 0
        ? Math.min(99, Math.floor((downloadState.completed / downloadState.total) * 100))
        : 0

    return {
      available: false,
      downloading: true,
      completed: downloadState.completed,
      total: downloadState.total,
      percent,
      expiresAt: null,
      downloadedAt: null,
      bytesDownloaded: downloadState.bytesDownloaded
    }
  }

  if (!packageState) {
    return {
      available: false,
      downloading: false,
      completed: 0,
      total: 0,
      percent: 0,
      expiresAt: null,
      downloadedAt: null,
      bytesDownloaded: 0
    }
  }

  return {
    available: true,
    downloading: false,
    completed: packageState.segmentCount,
    total: packageState.segmentCount,
    percent: 100,
    expiresAt: null,
    downloadedAt: packageState.downloadedAt,
    bytesDownloaded: packageState.payloads.reduce((sum, buffer) => sum + buffer.length, 0)
  }
}

export function beginMemoryDownload(total: number): void {
  downloadState = {
    active: true,
    cancelled: false,
    completed: 0,
    total,
    bytesDownloaded: 0
  }
}

export function isMemoryDownloadActive(): boolean {
  return downloadState.active
}

export function isMemoryDownloadCancelled(): boolean {
  return downloadState.cancelled
}

export function cancelMemoryDownload(): void {
  if (downloadState.active) {
    downloadState.cancelled = true
  }
}

export function markMemorySegmentDownloaded(bytes: number): void {
  downloadState.completed += 1
  downloadState.bytesDownloaded += bytes
}

export function endMemoryDownload(): void {
  downloadState.active = false
  downloadState.cancelled = false
}

export function clearMemoryVideo(): void {
  if (packageState) {
    for (const payload of packageState.payloads) {
      wipe(payload)
    }
  }
  packageState = null
}

export function setMemoryVideoPackage(next: MemoryVideoPackage): void {
  clearMemoryVideo()
  packageState = next
}

/**
 * Seal a CDN segment with the same at-rest crypto used for offline disk packages.
 * Returns the sealed blob to keep in RAM; wipes the CDN bytes afterward.
 */
export async function sealMemorySegment(cdnPayload: Buffer): Promise<Buffer> {
  try {
    return await encryptAtRest(cdnPayload)
  } finally {
    wipe(cdnPayload)
  }
}

/** Unseal a RAM segment — same decrypt path as reading an offline segment file. */
export async function readMemorySegment(index: number): Promise<Buffer | null> {
  if (!packageState) {
    return null
  }

  const sealed = packageState.payloads[index]
  if (!sealed) {
    return null
  }

  try {
    return await decryptAtRest(sealed)
  } catch {
    return null
  }
}

export function currentMemoryDownloadProgress(): Pick<
  MemoryVideoStatus,
  'completed' | 'total' | 'bytesDownloaded'
> {
  return {
    completed: downloadState.completed,
    total: downloadState.total,
    bytesDownloaded: downloadState.bytesDownloaded
  }
}
