import { execFile } from 'child_process'
import { dialog, app } from 'electron'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Chassis types that indicate phones / tablets / detachables (SMBBIOS). */
const BLOCKED_CHASSIS_TYPES = new Set([
  11, // Hand Held
  30, // Tablet
  32 // Detachable
])

export function isSupportedOs(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/**
 * Windows tablets / detachables report chassis types 11, 30, or 32.
 * macOS never runs Electron on iPhone/iPad — all Macs are laptop/desktop.
 * If detection fails, allow launch so real PCs with odd BIOS data are not locked out.
 */
export async function isBlockedTabletFormFactor(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance -ClassName Win32_SystemEnclosure).ChassisTypes | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )

    const trimmed = stdout.trim()
    if (!trimmed) {
      return false
    }

    const parsed: unknown = JSON.parse(trimmed)
    const types = (Array.isArray(parsed) ? parsed : [parsed])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))

    return types.some((type) => BLOCKED_CHASSIS_TYPES.has(type))
  } catch {
    return false
  }
}

/** Returns false when the process should stop (unsupported OS or tablet). */
export async function enforceDesktopLaptopOnly(): Promise<boolean> {
  if (!isSupportedOs()) {
    dialog.showErrorBox(
      'Unsupported Platform',
      'Pathnatya runs only on Windows and macOS laptops. Phones, tablets, and other operating systems are not supported.'
    )
    app.exit(1)
    return false
  }

  if (await isBlockedTabletFormFactor()) {
    dialog.showErrorBox(
      'Unsupported Device',
      'Pathnatya runs only on Windows and macOS laptops. Phones and tablets are not supported.'
    )
    app.exit(1)
    return false
  }

  return true
}
