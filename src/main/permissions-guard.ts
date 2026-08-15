import { accessSync, constants, promises as fs, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, shell, systemPreferences } from 'electron'

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

/** macOS: System Events / hide-others needs Accessibility trust. */
function checkMacAccessibility(): boolean {
  if (process.platform !== 'darwin') {
    return true
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

function macAccessibilityHowTo(): string {
  return (
    'Open System Settings → Privacy & Security → Accessibility, then enable Pathnatya. ' +
    'If Pathnatya is already listed, turn it off and on again.'
  )
}

function filesHowTo(): string {
  if (process.platform === 'darwin') {
    return (
      'Open System Settings → Privacy & Security → Files and Folders (or Full Disk Access) ' +
      'and allow Pathnatya to save files. Then restart the app.'
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
      'and allow Pathnatya to access your files.'
    )
  }

  return (
    'Allow Pathnatya to access your user folders. If Windows Security Controlled Folder Access ' +
    'is on, add Pathnatya to the allowed apps list.'
  )
}

export function getAppPermissionsStatus(): AppPermissionsStatus {
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
      granted: checkMacAccessibility(),
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
