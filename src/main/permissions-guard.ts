import { execFile, spawnSync } from 'child_process'
import { accessSync, constants, existsSync, promises as fs, unlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { app, shell, systemPreferences } from 'electron'

const execFileAsync = promisify(execFile)
const requireNative = createRequire(join(__dirname, 'index.js'))

export type FolderPermissionId = 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'

export type PermissionId =
  | 'files'
  | 'accessibility'
  | 'folders'
  | FolderPermissionId
  | 'music-library'
  | 'photo-library'

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

type ElectronFolderPath = FolderPermissionId

const PROBE_FILE = 'pathnatya-permission-probe'
const ACCESSIBILITY_PROBE_TIMEOUT_MS = 12_000
/** Wait for the user to Allow / Don’t Allow; do not treat a pending dialog as granted. */
const FOLDER_PROBE_TIMEOUT_MS = 180_000
const FILES_AND_FOLDERS_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
const ACCESSIBILITY_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const PHOTOS_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Photos'
const MEDIA_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Media'

const MAC_FOLDER_PERMISSIONS: Array<{
  id: FolderPermissionId
  pathName: ElectronFolderPath
  label: string
  description: string
}> = [
  {
    id: 'desktop',
    pathName: 'desktop',
    label: 'Desktop folder',
    description: 'Needed to check your Desktop for unauthorized copies of the video.'
  },
  {
    id: 'documents',
    pathName: 'documents',
    label: 'Documents folder',
    description: 'Needed to check Documents for unauthorized copies of the video.'
  },
  {
    id: 'downloads',
    pathName: 'downloads',
    label: 'Downloads folder',
    description: 'Needed to check Downloads for unauthorized copies of the video.'
  },
  {
    id: 'music',
    pathName: 'music',
    label: 'Music folder',
    description: 'Needed to check the Music folder for unauthorized copies of the video.'
  },
  {
    id: 'pictures',
    pathName: 'pictures',
    label: 'Pictures folder',
    description: 'Needed to check Pictures for unauthorized copies of the video.'
  },
  {
    id: 'videos',
    pathName: 'videos',
    label: 'Movies folder',
    description: 'Needed to check Movies for unauthorized copies of the video.'
  }
]

/** Once System Events accepts this process, keep treating Accessibility as granted. */
let macAccessibilityConfirmed = false
let macAccessibilityProbe: Promise<boolean> | null = null
let macAccessibilityPrompted = false

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

function isPermissionDeniedCode(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EACCES'
}

export function macFolderProbeIsGranted(input: {
  folderMissing: boolean
  lookupCode?: string
  lsStatus: number | null
  lsTimedOut: boolean
  lsOutput: string
}): boolean {
  if (input.folderMissing) {
    return true
  }

  if (input.lsTimedOut || isPermissionDeniedCode(input.lookupCode)) {
    return false
  }

  if (/operation not permitted|permission denied/i.test(input.lsOutput)) {
    return false
  }

  if (input.lsStatus === 0) {
    return true
  }

  if (/no such file or directory/i.test(input.lsOutput)) {
    return true
  }

  return false
}

/**
 * `/bin/ls` is blocked by macOS until the user answers Allow / Don’t Allow.
 * Node `readdir` can return success while that dialog is still open, which used
 * to skip the permissions page after a denial.
 */
function checkMacFolderReadable(pathName: ElectronFolderPath): boolean {
  let dir: string
  try {
    dir = app.getPath(pathName)
  } catch {
    return false
  }

  try {
    accessSync(dir, constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT'
  }

  let lookupCode: string | undefined
  try {
    accessSync(join(dir, `.pathnatya-tcc-${process.pid}`), constants.F_OK)
  } catch (error) {
    lookupCode = (error as NodeJS.ErrnoException).code
  }

  const result = spawnSync('/bin/ls', ['-A', '-1', dir], {
    encoding: 'utf8',
    timeout: FOLDER_PROBE_TIMEOUT_MS
  })
  const lsTimedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')
  const lsOutput = `${result.stderr ?? ''}\n${result.stdout ?? ''}`

  return macFolderProbeIsGranted({
    folderMissing: false,
    lookupCode,
    lsStatus: result.status,
    lsTimedOut,
    lsOutput
  })
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
 * especially after Accessibility is turned on while this process is still running.
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

/**
 * macOS: hide-others needs Accessibility trust.
 * Electron often still reports false after the toggle is on; System Events is the
 * source of truth. Folder denials are handled separately and still fail closed.
 */
async function checkMacAccessibility(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }

  if (macAccessibilityConfirmed || electronSaysTrustedAccessibility()) {
    macAccessibilityConfirmed = true
    return true
  }

  if (!macAccessibilityPrompted) {
    macAccessibilityPrompted = true
    if (requestAccessibilityPermission()) {
      macAccessibilityConfirmed = true
      return true
    }
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
  return (
    'Allow Pathnatya to access your user folders. If Windows Security Controlled Folder Access ' +
    'is on, add Pathnatya to the allowed apps list.'
  )
}

function macFolderHowTo(label: string): string {
  return (
    `When macOS asks, choose Allow. Or open System Settings → Privacy & Security → Files and Folders ` +
    `and enable ${label} for Pathnatya 2026.`
  )
}

type NodeMacPermissions = {
  getAuthStatus: (type: string) => string
  askForPhotosAccess: (level?: 'add-only' | 'read-write') => Promise<string>
  askForMusicLibraryAccess: () => Promise<string>
}

let nodeMacPermissions: NodeMacPermissions | null | undefined

function loadNodeMacPermissions(): NodeMacPermissions | null {
  if (process.platform !== 'darwin') {
    return null
  }

  if (nodeMacPermissions !== undefined) {
    return nodeMacPermissions
  }

  const candidates = [join(__dirname, 'vendor/node-mac-permissions'), 'node-mac-permissions']
  for (const candidate of candidates) {
    try {
      if (candidate !== 'node-mac-permissions' && !existsSync(join(candidate, 'package.json'))) {
        continue
      }
      nodeMacPermissions = requireNative(candidate) as NodeMacPermissions
      return nodeMacPermissions
    } catch {
      // try the next location
    }
  }

  nodeMacPermissions = null
  return null
}

function isLibraryStatusGranted(status: string): boolean {
  return status === 'authorized' || status === 'limited'
}

async function checkMacLibraryAccess(
  statusType: string,
  ask: (mod: NodeMacPermissions) => Promise<string>
): Promise<boolean> {
  const mod = loadNodeMacPermissions()
  if (!mod) {
    return false
  }

  let status = 'not determined'
  try {
    status = mod.getAuthStatus(statusType)
  } catch {
    status = 'not determined'
  }

  if (status === 'not determined') {
    try {
      status = await ask(mod)
    } catch (error) {
      console.warn('[mac-permissions] library request failed:', error)
      return false
    }
  }

  return isLibraryStatusGranted(status)
}

/** Shows “Pathnatya 2026 would like to access your music library.” */
async function checkMacMusicLibrary(): Promise<boolean> {
  return checkMacLibraryAccess('music-library', (mod) => mod.askForMusicLibraryAccess())
}

/** Shows “Pathnatya 2026 would like to access your Photo Library.” */
async function checkMacPhotoLibrary(): Promise<boolean> {
  return checkMacLibraryAccess('photos-read-write', (mod) => mod.askForPhotosAccess('read-write'))
}

function musicLibraryHowTo(): string {
  return (
    'When macOS asks to access your music library, choose Allow. Or open System Settings → ' +
    'Privacy & Security → Media & Apple Music and enable Pathnatya 2026.'
  )
}

function photoLibraryHowTo(): string {
  return (
    'When macOS asks to access your Photo Library, choose Allow. Or open System Settings → ' +
    'Privacy & Security → Photos and enable Pathnatya 2026.'
  )
}

export async function getAppPermissionsStatus(): Promise<AppPermissionsStatus> {
  const platform =
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'other'

  const filesPermission: AppPermission = {
    id: 'files',
    label: 'Files & app storage',
    description: 'Needed to store the offline video securely on this device.',
    required: true,
    granted: checkUserDataWritable(),
    howToEnable: filesHowTo()
  }

  if (process.platform === 'darwin') {
    const musicLibraryGranted = await checkMacMusicLibrary()
    const photoLibraryGranted = await checkMacPhotoLibrary()

    const permissions: AppPermission[] = [
      filesPermission,
      {
        id: 'music-library',
        label: 'Music library',
        description: 'Needed so Pathnatya can check your music library for unauthorized copies of the video.',
        required: true,
        granted: musicLibraryGranted,
        howToEnable: musicLibraryHowTo()
      },
      {
        id: 'photo-library',
        label: 'Photo Library',
        description: 'Needed so Pathnatya can check your Photo Library for unauthorized copies of the video.',
        required: true,
        granted: photoLibraryGranted,
        howToEnable: photoLibraryHowTo()
      },
      ...MAC_FOLDER_PERMISSIONS.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        required: true,
        granted: checkMacFolderReadable(item.pathName),
        howToEnable: macFolderHowTo(item.label)
      })),
      {
        id: 'accessibility',
        label: 'Accessibility',
        description: 'Needed so Pathnatya can keep focus on the video and hide other apps.',
        required: true,
        granted: await checkMacAccessibility(),
        howToEnable: macAccessibilityHowTo()
      }
    ]

    return {
      platform,
      allRequiredGranted:
        permissions.length > 0 && permissions.every((item) => !item.required || item.granted),
      permissions
    }
  }

  const permissions: AppPermission[] = [
    filesPermission,
    {
      id: 'folders',
      label: 'User folders',
      description: 'Needed to protect the video by checking this device for unauthorized copies.',
      required: true,
      granted: checkHomeReadable(),
      howToEnable: foldersHowTo()
    }
  ]

  const allRequiredGranted =
    permissions.length > 0 && permissions.every((item) => !item.required || item.granted)

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
    if (id === 'accessibility') {
      requestAccessibilityPermission()
      await shell.openExternal(ACCESSIBILITY_SETTINGS)
      return
    }

    if (id === 'photo-library') {
      await shell.openExternal(PHOTOS_SETTINGS)
      return
    }

    if (id === 'music-library') {
      await shell.openExternal(MEDIA_SETTINGS)
      return
    }

    await shell.openExternal(FILES_AND_FOLDERS_SETTINGS)
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
