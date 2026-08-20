/** Keep in sync with `videoVersion` in package.json. */
export const PROJECT_VIDEO_VERSION = '1.0.0'

export function parseVideoVersion(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return null
}

export function majorVersion(value: string): number {
  const n = Number.parseInt(value.replace(/^v/i, '').split('.')[0] ?? '0', 10)
  return Number.isFinite(n) ? n : 0
}

/** True when the leading semver number changed, e.g. 1.0.0 → 2.0.0. */
export function isVideoMajorVersionChange(previous: string, next: string): boolean {
  return majorVersion(previous) !== majorVersion(next)
}
