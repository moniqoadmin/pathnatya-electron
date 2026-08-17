import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Uptime can tick between persist and the next read; require a clear regression. */
export const UPTIME_REBOOT_SLACK_SEC = 2

const PROBE_TIMEOUT_MS = 4000

/**
 * OS-provided boot identifier when the platform has one that does not follow the
 * wall clock. Windows has no such id — callers combine this with uptime regression.
 */
export async function readOsBootId(): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const id = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      return id || null
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true
      })
      const trimmed = stdout.trim()
      return trimmed || null
    }
  } catch {
    return null
  }

  return null
}

/** Seconds since OS boot. Independent of the wall clock on Windows, macOS, and Linux. */
export function readUptimeSec(): number {
  return os.uptime()
}

/** True when OS uptime went backwards — the machine rebooted (or the tick counter reset). */
export function isUptimeReboot(
  previousUptimeSec: number | undefined,
  currentUptimeSec: number
): boolean {
  if (previousUptimeSec == null || !Number.isFinite(previousUptimeSec)) {
    return false
  }

  if (!Number.isFinite(currentUptimeSec) || currentUptimeSec < 0) {
    return false
  }

  return currentUptimeSec + UPTIME_REBOOT_SLACK_SEC < previousUptimeSec
}

/**
 * Prefer the OS boot id. Otherwise keep the previous UUID for this boot, or mint a
 * new one when this is the first stamp or an uptime-detected reboot.
 */
export function nextBootId(
  osBootId: string | null,
  reboot: boolean,
  previousBootId: string | undefined
): string {
  if (osBootId) {
    return osBootId
  }

  if (!reboot && previousBootId) {
    return previousBootId
  }

  return randomUUID()
}
