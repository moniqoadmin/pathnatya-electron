/** Runtime HLS + tamper-scan settings loaded from GET /app-configurations. */

export interface AppVideoScene {
  scene: number
  label: string
  /** Clock as `m.ss` or `m:ss`, e.g. `1.58`. */
  time: string
}

export interface AppVideoConfiguration {
  hlsSource: string
  allowedHosts: string[]
  /** Basenames the drive scanner treats as protected copies. */
  videoFiles: string[]
  /** Seek-bar scene markers from `VIDEO_SCENES`. Empty when the key is missing. */
  videoScenes: AppVideoScene[]
  /**
   * Exclusive expiry instant from `END_DATE` (`DD.MM.YYYY`, e.g. `06.01.2026`).
   * Video is valid through that calendar day (UTC) and deleted at 00:00 the next day.
   * Null when the key is omitted — callers then use 15 days from trusted now.
   */
  endDate: string | null
}

/** When `END_DATE` is omitted, video and offline login last 15 days from trusted now. */
export const FALLBACK_VIDEO_TTL_MS = 21 * 24 * 60 * 60 * 1000

/** `END_DATE` when present; otherwise `serverNowMs + 15 days`. */
export function resolveVideoExpiresAt(endDate: string | null, serverNowMs: number): string {
  if (endDate) {
    return new Date(endDate).toISOString()
  }

  return new Date(serverNowMs + FALLBACK_VIDEO_TTL_MS).toISOString()
}

function uniqueLower(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(value)
  }

  return result
}

function hostnameFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    return url.hostname || null
  } catch {
    return null
  }
}

function normalizeHost(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.includes('://')) {
    return hostnameFromUrl(trimmed)
  }

  const host = trimmed.split('/')[0]?.split(':')[0]?.trim()
  return host || null
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const items: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      items.push(entry.trim())
    }
  }

  return items
}

const CLOCK_TIME = /^(\d+)[:.]([0-5]?\d)$/u

function isClockTime(value: string): boolean {
  return CLOCK_TIME.test(value.trim())
}

function firstNonEmptyScenes(...lists: AppVideoScene[][]): AppVideoScene[] {
  for (const list of lists) {
    if (list.length > 0) {
      return list
    }
  }

  return []
}

function firstEndDate(...dates: Array<string | null>): string | null {
  for (const date of dates) {
    if (date) {
      return date
    }
  }

  return null
}

const DOTTED_END_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u
const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u

function exclusiveUtcExpiry(year: number, month: number, day: number): string {
  const start = Date.UTC(year, month - 1, day)
  const asUtc = new Date(start)
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    throw new Error('7534 : Video end date in app configuration is invalid.')
  }

  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString()
}

/**
 * `END_DATE` from GET /app-configurations. `06.01.2026` is 6 January 2026;
 * access lasts through that UTC day.
 */
export function parseEndDate(value: unknown): string | null {
  if (value == null || value === '') {
    return null
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('7534 : Video end date in app configuration is invalid.')
  }

  const trimmed = String(value).trim()
  if (!trimmed) {
    return null
  }

  const dotted = DOTTED_END_DATE.exec(trimmed)
  if (dotted) {
    return exclusiveUtcExpiry(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]))
  }

  const isoDate = ISO_DATE_ONLY.exec(trimmed)
  if (isoDate) {
    return exclusiveUtcExpiry(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]))
  }

  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString()
  }

  throw new Error('7534 : Video end date in app configuration is invalid.')
}

function endDateFromConfig(
  record: Record<string, unknown>,
  videoConfig: Record<string, unknown>
): string | null {
  return parseEndDate(
    videoConfig.END_DATE ?? videoConfig.endDate ?? record.END_DATE ?? record.endDate
  )
}

/**
 * Scene markers from `VIDEO_SCENES`. Missing or invalid input yields [] —
 * playback must not fail when the key is absent.
 */
export function parseVideoScenes(value: unknown): AppVideoScene[] {
  if (value == null || value === '') {
    return []
  }

  let raw: unknown = value
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      return []
    }

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        raw = JSON.parse(trimmed) as unknown
      } catch {
        return []
      }
    } else {
      raw = trimmed.split(/[,;]/u).map((part) => part.trim()).filter(Boolean)
    }
  }

  if (!Array.isArray(raw)) {
    return []
  }

  const scenes: AppVideoScene[] = []

  for (const entry of raw) {
    if (typeof entry === 'string') {
      const time = entry.trim()
      if (!isClockTime(time)) {
        continue
      }

      const scene = scenes.length + 1
      scenes.push({ scene, label: `Scene ${scene}`, time })
      continue
    }

    if (!entry || typeof entry !== 'object') {
      continue
    }

    const record = entry as Record<string, unknown>
    const time = typeof record.time === 'string' ? record.time.trim() : ''
    if (!isClockTime(time)) {
      continue
    }

    const scene =
      typeof record.scene === 'number' && Number.isFinite(record.scene) && record.scene > 0
        ? Math.floor(record.scene)
        : scenes.length + 1
    const label =
      typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : `Scene ${scene}`
    scenes.push({ scene, label, time })
  }

  return scenes
}

function scenesFromConfig(
  record: Record<string, unknown>,
  videoConfig: Record<string, unknown>
): AppVideoScene[] {
  return parseVideoScenes(
    videoConfig.VIDEO_SCENES ??
      videoConfig.videoScenes ??
      record.VIDEO_SCENES ??
      record.videoScenes
  )
}

/** Basenames from `videoFiles` strings or `{ name | file | filename | path }` objects. */
export function parseVideoFileNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const names: string[] = []

  for (const entry of value) {
    let raw = ''

    if (typeof entry === 'string') {
      raw = entry.trim()
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      const candidate = record.name ?? record.file ?? record.filename ?? record.path
      if (typeof candidate === 'string') {
        raw = candidate.trim()
      }
    }

    if (!raw) {
      continue
    }

    const base = raw.replace(/\\/gu, '/').split('/').pop()?.trim()
    if (base) {
      names.push(base)
    }
  }

  return uniqueLower(names)
}

function normalizeHlsSource(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('1843 : Video source is missing from app configuration.')
  }

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('647 : Video source URL is invalid.')
  }

  if (url.protocol !== 'https:') {
    throw new Error('3928 : Video source must be served over HTTPS.')
  }

  return url.toString()
}

function hostsFromConfig(hlsSource: string, allowedHosts: unknown): string[] {
  const hosts = readStringList(allowedHosts)
    .map((host) => normalizeHost(host))
    .filter((host): host is string => Boolean(host))

  const sourceHost = hostnameFromUrl(hlsSource)
  if (sourceHost) {
    hosts.push(sourceHost)
  }

  return uniqueLower(hosts)
}

function videoConfigRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

/**
 * GET /app-configurations returns `{ data: [ { videoConfig, videoFiles } ] }`.
 * Stored IPC config uses `{ hlsSource, ... }` and must not be unwrapped.
 */
function unwrapAppConfigurationsPayload(data: unknown): unknown {
  const record = videoConfigRecord(data)
  if (!record || record.data === undefined) {
    return data
  }

  if (
    typeof record.hlsSource === 'string' ||
    record.videoConfig !== undefined ||
    record.DEFAULT_HLS_SOURCE !== undefined
  ) {
    return data
  }

  return record.data
}

function parseAppConfigurationItem(item: unknown): AppVideoConfiguration | null {
  const record = videoConfigRecord(item)
  if (!record) {
    return null
  }

  const videoConfig = videoConfigRecord(record.videoConfig) ?? record
  const sourceRaw = videoConfig.DEFAULT_HLS_SOURCE ?? videoConfig.hlsSource
  if (typeof sourceRaw !== 'string' || !sourceRaw.trim()) {
    return null
  }

  const hlsSource = normalizeHlsSource(sourceRaw)
  return {
    hlsSource,
    allowedHosts: hostsFromConfig(
      hlsSource,
      videoConfig.ALLOWED_HOSTS ?? videoConfig.allowedHosts
    ),
    videoFiles: parseVideoFileNames(record.videoFiles ?? videoConfig.videoFiles),
    videoScenes: scenesFromConfig(record, videoConfig),
    endDate: endDateFromConfig(record, videoConfig)
  }
}

/**
 * Accepts the GET /app-configurations array, a single API row, or the stored
 * `{ hlsSource, allowedHosts, videoFiles, videoScenes, endDate }` shape used over IPC / offline session.
 */
export function parseAppConfigurationsPayload(payload: unknown): AppVideoConfiguration {
  const data = unwrapAppConfigurationsPayload(payload)

  if (Array.isArray(data)) {
    const parsed = data
      .map((item) => parseAppConfigurationItem(item))
      .filter((item): item is AppVideoConfiguration => item !== null)

    if (parsed.length === 0) {
      throw new Error('1843 : App configuration did not include a video source.')
    }

    const [first, ...rest] = parsed
    const videoFiles = uniqueLower([
      ...first.videoFiles,
      ...rest.flatMap((item) => item.videoFiles)
    ])

    return {
      hlsSource: first.hlsSource,
      allowedHosts: uniqueLower([
        ...first.allowedHosts,
        ...rest.flatMap((item) => item.allowedHosts)
      ]),
      videoFiles,
      videoScenes: firstNonEmptyScenes(first.videoScenes, ...rest.map((item) => item.videoScenes)),
      endDate: firstEndDate(first.endDate, ...rest.map((item) => item.endDate))
    }
  }

  const stored = videoConfigRecord(data)
  if (stored && typeof stored.hlsSource === 'string') {
    const hlsSource = normalizeHlsSource(stored.hlsSource)
    return {
      hlsSource,
      allowedHosts: hostsFromConfig(hlsSource, stored.allowedHosts),
      videoFiles: parseVideoFileNames(stored.videoFiles),
      videoScenes: parseVideoScenes(stored.videoScenes ?? stored.VIDEO_SCENES),
      endDate: parseEndDate(stored.endDate ?? stored.END_DATE)
    }
  }

  const single = parseAppConfigurationItem(data)
  if (!single) {
    throw new Error('1843 : App configuration did not include a video source.')
  }

  return single
}
