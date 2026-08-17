import { execFile } from 'child_process'
import { accessSync, constants, promises as fs, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { app, shell, systemPreferences } from 'electron'

const execFileAsync = promisify(execFile)

export type PermissionId = 'files' | 'accessibility' | 'folders'

export type AppPermission = {
  id: PermissionId
  label: string
  description: string
  required: boolean
  granted: boolean
  /** Short steps shown under the permission when it is missing. */
  howToEnable: string
}

export type AppPermissionsStatus = {
  platform: 'darwin' | 'win32' | 'other'
  allRequiredGranted: boolean
  permissions: AppPermission[]
}

const PROBE_FILE = 'pathnatya-permission-probe'
const ACCESSIBILITY_PROBE_TIMEOUT_MS = 12_000

/** Once System Events accepts this process, keep treating Accessibility as granted. */
let macAccessibilityConfirmed = false
let macAccessibilityProbe: Promise<boolean> | null = null

function checkUserDataWritable(): boolean {
  try {
    const dir = app.getPath('userData')
    accessSync(dir, constants.R_OK | constants.W_OK)
    const probe = join(dir, PROBE_FILE)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** Needed so the duplicate-file scan can walk the user profile. */
function checkHomeReadable(): boolean {
  try {
    accessSync(homedir(), constants.R_OK)
    return true
  } catch {
    return false
  }
}

function electronSaysTrustedAccessibility(): boolean {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

/**
 * Electron's isTrustedAccessibilityClient is a known false negative on recent macOS,
 * especially while the current process is still running after the toggle is turned on.
 * Probe the same System Events access used to hide other apps.
 */
async function probeMacAccessibilityViaSystemEvents(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get unix id of first process whose background only is false'
      ],
      { encoding: 'utf8', timeout: ACCESSIBILITY_PROBE_TIMEOUT_MS }
    )
    return /^\s*\d+\s*$/.test(stdout)
  } catch {
    return false
  }
}

/** macOS: System Events / hide-others needs Accessibility trust. */
async function checkMacAccessibility(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }

  if (macAccessibilityConfirmed || electronSaysTrustedAccessibility()) {
    macAccessibilityConfirmed = true
    return true
  }

  if (macAccessibilityProbe) {
    return macAccessibilityProbe
  }

  macAccessibilityProbe = probeMacAccessibilityViaSystemEvents()
    .then((probed) => {
      if (probed) {
        macAccessibilityConfirmed = true
      }
      return probed
    })
    .finally(() => {
      macAccessibilityProbe = null
    })

  return macAccessibilityProbe
}

function macAccessibilityHowTo(): string {
  return (
    'Open System Settings → Privacy & Security → Accessibility, then enable Pathnatya 2026. ' +
    'If macOS asks to control System Events, choose Allow. After it is on, tap Restart Pathnatya — ' +
    'macOS does not apply this permission until the app fully quits (closing the window is not enough). ' +
    'If Pathnatya 2026 is already listed, turn it off and on again, then restart.'
  )
}

function filesHowTo(): string {
  if (process.platform === 'darwin') {
    return (
      'Open System Settings → Privacy & Security → Files and Folders (or Full Disk Access) ' +
      'and allow Pathnatya 2026 to save files. Then restart the app.'
    )
  }

  return (
    'Make sure Pathnatya can write under your user profile. If Controlled Folder Access ' +
    'or antivirus is blocking it, allow Pathnatya in Windows Security → Virus & threat protection ' +
    '→ Ransomware protection → Allow an app.'
  )
}

function foldersHowTo(): string {
  if (process.platform === 'darwin') {
    return (
      'Open System Settings → Privacy & Security → Files and Folders / Full Disk Access ' +
      'and allow Pathnatya 2026 to access your files.'
    )
  }

  return (
    'Allow Pathnatya to access your user folders. If Windows Security Controlled Folder Access ' +
    'is on, add Pathnatya to the allowed apps list.'
  )
}

export async function getAppPermissionsStatus(): Promise<AppPermissionsStatus> {
  const platform =
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'other'

  const permissions: AppPermission[] = [
    {
      id: 'files',
      label: 'Files & app storage',
      description: 'Needed to store the offline video securely on this device.',
      required: true,
      granted: checkUserDataWritable(),
      howToEnable: filesHowTo()
    },
    {
      id: 'folders',
      label: 'User folders',
      description: 'Needed to protect the video by checking this device for unauthorized copies.',
      required: true,
      granted: checkHomeReadable(),
      howToEnable: foldersHowTo()
    }
  ]

  if (process.platform === 'darwin') {
    permissions.push({
      id: 'accessibility',
      label: 'Accessibility',
      description: 'Needed so Pathnatya can keep focus on the video and hide other apps.',
      required: true,
      granted: await checkMacAccessibility(),
      howToEnable: macAccessibilityHowTo()
    })
  }

  const allRequiredGranted = permissions.every((item) => !item.required || item.granted)

  return {
    platform,
    allRequiredGranted,
    permissions
  }
}

/** Prompt macOS to trust Accessibility (shows the system dialog when possible). */
export function requestAccessibilityPermission(): boolean {
  if (process.platform !== 'darwin') {
    return true
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(true)
  } catch {
    return false
  }
}

/** Fully quit and reopen so macOS reapplies Accessibility to a new process. */
export function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}

export async function openPermissionSettings(id?: PermissionId): Promise<void> {
  if (process.platform === 'darwin') {
    if (id === 'files' || id === 'folders') {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
      )
      return
    }

    requestAccessibilityPermission()
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
    return
  }

  if (process.platform === 'win32') {
    if (id === 'files' || id === 'folders') {
      await shell.openExternal('ms-settings:windowsdefender')
      return
    }

    await shell.openExternal('ms-settings:privacy')
  }
}

/** Removes a leftover probe file if a previous check crashed mid-write. */
export async function cleanupPermissionProbe(): Promise<void> {
  try {
    await fs.rm(join(app.getPath('userData'), PROBE_FILE), { force: true })
  } catch {
    // ignore
  }
}
