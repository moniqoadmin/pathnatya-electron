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

/** True when latest's leading semver number is greater than current's, e.g. 1.0.0 → 2.0.0. */
export function isNewerVideoVersion(latest: string, current: string): boolean {
  return majorVersion(latest) > majorVersion(current)
}
