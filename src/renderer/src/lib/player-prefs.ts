const VOLUME_STORAGE_KEY = 'pathnatya_volume'

export function readStoredVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY)
    if (raw == null) {
      return 1
    }

    const value = Number(raw)
    if (!Number.isFinite(value)) {
      return 1
    }

    return Math.min(1, Math.max(0, value))
  } catch {
    return 1
  }
}

export function writeStoredVolume(value: number): void {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(value))
  } catch {
    /* ignore quota / private mode */
  }
}
