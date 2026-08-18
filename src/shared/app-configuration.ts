/** Runtime HLS + tamper-scan settings loaded from GET /app-configurations. */

export interface AppVideoConfiguration {
  hlsSource: string
  allowedHosts: string[]
  /** Basenames the drive scanner treats as protected copies. */
  videoFiles: string[]
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
    videoFiles: parseVideoFileNames(record.videoFiles ?? videoConfig.videoFiles)
  }
}

/**
 * Accepts the GET /app-configurations array, a single API row, or the stored
 * `{ hlsSource, allowedHosts, videoFiles }` shape used over IPC / offline session.
 */
export function parseAppConfigurationsPayload(data: unknown): AppVideoConfiguration {
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
      videoFiles
    }
  }

  const stored = videoConfigRecord(data)
  if (stored && typeof stored.hlsSource === 'string') {
    const hlsSource = normalizeHlsSource(stored.hlsSource)
    return {
      hlsSource,
      allowedHosts: hostsFromConfig(hlsSource, stored.allowedHosts),
      videoFiles: parseVideoFileNames(stored.videoFiles)
    }
  }

  const single = parseAppConfigurationItem(data)
  if (!single) {
    throw new Error('1843 : App configuration did not include a video source.')
  }

  return single
}
