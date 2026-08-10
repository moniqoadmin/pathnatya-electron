import { execFile } from 'child_process'
import { dialog, app, screen } from 'electron'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Chassis types that indicate phones / tablets / detachables (SMBBIOS). */
const BLOCKED_CHASSIS_TYPES = new Set([
  11, // Hand Held
  30, // Tablet
  32 // Detachable
])

/**
 * Smallest laptop-class panel we allow (DIP / CSS pixels from Electron).
 * Phones and tiny tablets fall below this; Windows tablet chassis types are
 * blocked separately even when their pixel count looks laptop-sized.
 */
export const MIN_SCREEN_WIDTH = 1280
export const MIN_SCREEN_HEIGHT = 720

export function isSupportedOs(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/**
 * True when a display size is too small for a laptop (phones / small tablets).
 * Uses the longer side as width so portrait tablets are caught the same way.
 */
export function isScreenSizeTooSmall(width: number, height: number): boolean {
  const longSide = Math.max(width, height)
  const shortSide = Math.min(width, height)
  return longSide < MIN_SCREEN_WIDTH || shortSide < MIN_SCREEN_HEIGHT
}

/** True when the primary display is below the laptop minimum. */
export function isScreenTooSmall(): boolean {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    return isScreenSizeTooSmall(width, height)
  } catch {
    // If Electron cannot read the display, do not lock the user out.
    return false
  }
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

/** Returns false when the process should stop (unsupported OS, tablet, or tiny screen). */
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

  if (isScreenTooSmall()) {
    dialog.showErrorBox(
      'Screen Too Small',
      'Pathnatya requires a laptop or desktop screen. Phones and small tablets are not supported.'
    )
    app.exit(1)
    return false
  }

  return true
}
