import { execFile } from 'child_process'
import { basename } from 'path'
import { promisify } from 'util'
import type { BrowserWindow } from 'electron'
import { getVirtualMachineVerdict } from './vm-guard'

const execFileAsync = promisify(execFile)

/** Why playback is blocked, so the renderer can explain it accurately. */
export type CaptureReason = '' | 'recorder' | 'virtual-machine'

export type ScreenCaptureState = {
  active: boolean
  appName: string
  reason: CaptureReason
}

const IDLE_STATE: ScreenCaptureState = { active: false, appName: '', reason: '' }

type CaptureSignature = { name: string; processes: string[] }

/**
 * Only dedicated recorders, remote-control tools, and share helper processes are
 * listed. Meeting apps (Zoom, Teams) idle in the tray on most machines, so their
 * main process is deliberately absent — Zoom is matched on CptHost, which only
 * runs while a screen is actually being shared.
 */
const WINDOWS_SIGNATURES: CaptureSignature[] = [
  { name: 'OBS Studio', processes: ['obs64.exe', 'obs32.exe', 'obs.exe'] },
  { name: 'Streamlabs Desktop', processes: ['streamlabs obs.exe', 'streamlabs desktop.exe'] },
  { name: 'XSplit', processes: ['xsplit.core.exe', 'xsplit.broadcaster.exe'] },
  { name: 'Camtasia', processes: ['camtasiastudio.exe', 'camtasia.exe', 'camrecorder.exe'] },
  { name: 'Bandicam', processes: ['bdcam.exe', 'bandicam.exe'] },
  { name: 'Snagit', processes: ['snagit32.exe', 'snagiteditor.exe', 'snagitcapture.exe'] },
  { name: 'ShareX', processes: ['sharex.exe'] },
  { name: 'ScreenToGif', processes: ['screentogif.exe'] },
  { name: 'Loom', processes: ['loom.exe'] },
  { name: 'Action!', processes: ['action.exe', 'action_x64.exe'] },
  { name: 'Fraps', processes: ['fraps.exe'] },
  { name: 'FlashBack Recorder', processes: ['flashbackrecorder.exe'] },
  { name: 'ApowerREC', processes: ['apowerrec.exe'] },
  { name: 'Movavi Screen Recorder', processes: ['screenrecorder.exe'] },
  { name: 'Snipping Tool', processes: ['snippingtool.exe', 'screenclippinghost.exe'] },
  { name: 'Screen Recorder', processes: ['recforth.exe'] },
  { name: 'Zoom screen sharing', processes: ['cpthost.exe'] },
  { name: 'TeamViewer', processes: ['teamviewer.exe', 'teamviewer_desktop.exe'] },
  { name: 'AnyDesk', processes: ['anydesk.exe'] },
  { name: 'RustDesk', processes: ['rustdesk.exe'] },
  { name: 'Chrome Remote Desktop', processes: ['remoting_host.exe'] },
  { name: 'VNC server', processes: ['vncserver.exe', 'winvnc.exe', 'tvnserver.exe'] },
  { name: 'Steps Recorder', processes: ['psr.exe'] }
]

const MACOS_SIGNATURES: CaptureSignature[] = [
  { name: 'macOS screen recording', processes: ['screencaptureui', 'screencapture'] },
  { name: 'QuickTime Player', processes: ['quicktime player'] },
  { name: 'OBS Studio', processes: ['obs'] },
  { name: 'Streamlabs Desktop', processes: ['streamlabs desktop'] },
  { name: 'Loom', processes: ['loom'] },
  { name: 'ScreenFlow', processes: ['screenflow'] },
  { name: 'Camtasia', processes: ['camtasia'] },
  { name: 'Snagit', processes: ['snagit'] },
  { name: 'CleanShot X', processes: ['cleanshot x'] },
  { name: 'Kap', processes: ['kap'] },
  { name: 'Zoom screen sharing', processes: ['cpthost', 'zoomcpthost'] },
  { name: 'TeamViewer', processes: ['teamviewer', 'teamviewer_desktop'] },
  { name: 'AnyDesk', processes: ['anydesk'] },
  { name: 'RustDesk', processes: ['rustdesk'] },
  {
    name: 'Chrome Remote Desktop',
    processes: ['chrome remote desktop host', 'remoting_me2me_host']
  }
]

/**
 * Windows records every screen-capture session here, the same data the privacy
 * indicator uses. An entry with a start time and no stop time is capturing right
 * now, which catches recorders and browser-based screen shares without having to
 * know the app by name.
 */
const CAPTURE_CONSENT_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureProgrammatic'
]

const PACKAGED_APP_NAMES: Record<string, string> = {
  'microsoft.screensketch': 'Snipping Tool',
  'microsoft.xboxgamingoverlay': 'Xbox Game Bar',
  'microsoft.windowscamera': 'Camera',
  msteams: 'Microsoft Teams',
  'microsoft.teams': 'Microsoft Teams',
  'microsoft.skypeapp': 'Skype'
}

const EXECUTABLE_APP_NAMES: Record<string, string> = {
  'chrome.exe': 'Google Chrome',
  'msedge.exe': 'Microsoft Edge',
  'firefox.exe': 'Firefox',
  'brave.exe': 'Brave',
  'opera.exe': 'Opera',
  'vivaldi.exe': 'Vivaldi',
  'zoom.exe': 'Zoom',
  'ms-teams.exe': 'Microsoft Teams',
  'teams.exe': 'Microsoft Teams',
  'slack.exe': 'Slack',
  'discord.exe': 'Discord',
  'webexmta.exe': 'Webex',
  'obs64.exe': 'OBS Studio',
  'obs32.exe': 'OBS Studio'
}

/**
 * Recorders pulled off the web often use legacy capture APIs (GDI, DXGI desktop
 * duplication, bundled ffmpeg) that never register with the Windows privacy system,
 * so they miss both the consent-store signal and the exact name list above. As a
 * backstop, any running process whose name contains a telltale capture keyword is
 * treated as a recorder. This intentionally errs toward pausing, matching the app's
 * strict posture (it already pauses on blur and outside full screen).
 */
const RECORDER_NAME_KEYWORDS = [
  'screenrec',
  'screen record',
  'screen-record',
  'scrnrec',
  'screencast',
  'screen cast',
  'screencap',
  'screen capture',
  'screen-capture',
  'screengrab',
  'screen grab',
  'screenshot',
  'camrec',
  'vidrec',
  'video record',
  'video capture',
  'recorder',
  'capture card',
  'screen2',
  'recmyscreen',
  'debut',
  'icecream', 
  'screen recorder',
  'screen capture',
  'screen capture tool',
  'screen capture software',
  'screen capture tool',
]

/**
 * Store recorders are the common case for non-technical users, and their package
 * name gives them away even when the executable does not (IOForth's "Screen Record"
 * ships as RecForth.exe). Installed packages are matched on name, then resolved to
 * the executables that actually show up in the process list.
 */
const PACKAGED_RECORDER_INCLUDE = 'record|screen|capture|cast|grab'
const PACKAGED_RECORDER_EXCLUDE = 'sound|audio|voice|dictat|capturepicker'

const POLL_MS = 2000
const PROCESS_LIST_TIMEOUT_MS = 4000
const REGISTRY_TIMEOUT_MS = 4000
const PACKAGE_SCAN_TIMEOUT_MS = 30000
const PACKAGE_RESCAN_MS = 5 * 60 * 1000

type PackagedRecorder = { executable: string; appName: string }

let pollTimeoutId: NodeJS.Timeout | null = null
let currentState: ScreenCaptureState = IDLE_STATE
let packagedRecorders: PackagedRecorder[] = []
let packageScanAt = 0

export function getScreenCaptureState(): ScreenCaptureState {
  return currentState
}

async function listProcessNames(): Promise<string[] | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist.exe', ['/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        timeout: PROCESS_LIST_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      })

      return stdout
        .split(/\r?\n/)
        .map((line) => /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase() ?? '')
        .filter(Boolean)
    }

    const { stdout } = await execFileAsync('ps', ['-Ao', 'comm='], {
      encoding: 'utf8',
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    })

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split('/').pop()?.toLowerCase() ?? '')
      .filter(Boolean)
  } catch {
    return null
  }
}

function describeConsentSubject(key: string, running: string[]): string | null {
  const subject = key.split('\\').pop() ?? ''

  if (/\\NonPackaged\\/i.test(key)) {
    // Paths are stored with '#' in place of the separator, e.g. C:#Program Files#...
    const executable = subject.split('#').pop()?.toLowerCase() ?? ''

    // A dead process can leave a session looking open forever, and our own window
    // must never count as a capturer.
    if (!executable || !running.includes(executable)) {
      return null
    }

    if (executable === basename(process.execPath).toLowerCase()) {
      return null
    }

    return EXECUTABLE_APP_NAMES[executable] ?? executable.replace(/\.exe$/i, '')
  }

  const family = subject.split('_')[0] ?? ''
  if (!family) {
    return null
  }

  return PACKAGED_APP_NAMES[family.toLowerCase()] ?? family
}

/**
 * Reads `reg query /s` output and returns the name of an app whose capture session
 * is still open (a start time with no matching stop time).
 */
export function findCapturingAppInConsentDump(stdout: string, running: string[]): string | null {
  let currentKey = ''
  let start = 0n
  let stop = 0n

  const verdict = (): string | null => {
    if (!currentKey || start === 0n || stop !== 0n) {
      return null
    }

    return describeConsentSubject(currentKey, running)
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      const detected = verdict()
      if (detected) {
        return detected
      }

      currentKey = line.trim()
      start = 0n
      stop = 0n
      continue
    }

    const value = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line)
    if (!value) {
      continue
    }

    if (value[1].toLowerCase() === 'lastusedtimestart') {
      start = BigInt(value[2])
    } else {
      stop = BigInt(value[2])
    }
  }

  return verdict()
}

/** Name of an app currently holding a screen-capture session, if any. */
async function findActiveCaptureConsent(running: string[]): Promise<string | null> {
  for (const consentKey of CAPTURE_CONSENT_KEYS) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', consentKey, '/s'], {
        encoding: 'utf8',
        timeout: REGISTRY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      })

      const detected = findCapturingAppInConsentDump(stdout, running)
      if (detected) {
        return detected
      }
    } catch {
      // Missing key simply means nothing has ever captured under this capability.
      continue
    }
  }

  return null
}

function matchesSignature(running: string[], signature: CaptureSignature): boolean {
  return signature.processes.some((name) =>
    running.some((candidate) => candidate === name || candidate.startsWith(`${name} `))
  )
}

/** "IOForth.Screenrecord-screenrecorder" -> "Screenrecorder" */
function describePackageName(packageName: string): string {
  const withoutPublisher = packageName.includes('.')
    ? packageName.slice(packageName.indexOf('.') + 1)
    : packageName

  const words = withoutPublisher.split(/[-_.]+/).filter(Boolean)

  // Names often repeat themselves ("Screenrecord-screenrecorder"); keep the longest
  // of any pair where one is simply a prefix of the other.
  const kept = words.filter(
    (word, index) =>
      !words.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.toLowerCase().startsWith(word.toLowerCase()) &&
          other.length > word.length
      )
  )

  return kept
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim()
}

/** Parses "PackageName|Folder\App.exe" lines into executables to watch for. */
export function parsePackagedRecorders(stdout: string): PackagedRecorder[] {
  const recorders: PackagedRecorder[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const [packageName, executablePath] = line.trim().split('|')
    if (!packageName || !executablePath) {
      continue
    }

    const executable = executablePath.split('\\').pop()?.toLowerCase() ?? ''
    if (!executable.endsWith('.exe')) {
      continue
    }

    if (recorders.some((entry) => entry.executable === executable)) {
      continue
    }

    recorders.push({ executable, appName: describePackageName(packageName) })
  }

  return recorders
}

/** Finds installed Store recorders and caches the executables they run as. */
async function loadPackagedRecorders(): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }

  packageScanAt = Date.now()

  const script =
    `Get-AppxPackage | Where-Object { $_.Name -match '${PACKAGED_RECORDER_INCLUDE}' ` +
    `-and $_.Name -notmatch '${PACKAGED_RECORDER_EXCLUDE}' } | ForEach-Object { $p=$_; ` +
    'try { ($p | Get-AppxPackageManifest).Package.Applications.Application | ' +
    'ForEach-Object { "$($p.Name)|$($_.Executable)" } } catch { } }'

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: PACKAGE_SCAN_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    )

    packagedRecorders = parsePackagedRecorders(stdout)
  } catch {
    // Keep whatever was found previously; the name list still covers common tools.
  }
}

function toDisplayName(processName: string): string {
  return processName
    .replace(/\.(exe|app)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

/**
 * Name of a running process that looks like a screen recorder by keyword, if any.
 * Used as a backstop for tools not covered by the consent signal or exact list.
 */
export function matchRecorderByKeyword(running: string[]): string | null {
  const self = basename(process.execPath).toLowerCase()

  for (const processName of running) {
    if (processName === self) {
      continue
    }

    const normalized = processName.replace(/\.(exe|app)$/i, '').replace(/[_-]+/g, ' ')

    if (RECORDER_NAME_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
      return toDisplayName(processName)
    }
  }

  return null
}

async function detectCapture(): Promise<ScreenCaptureState> {
  // Inside a VM the host records the guest display directly, where neither content
  // protection nor any in-guest recorder check can see it. Hardware cannot stop
  // being virtual, so this verdict latches for the rest of the session.
  const vm = getVirtualMachineVerdict()
  if (vm.virtual) {
    return { active: true, appName: vm.vendor, reason: 'virtual-machine' }
  }

  const running = await listProcessNames()

  // A failed process listing must not block playback; keep the previous verdict.
  if (!running) {
    return currentState
  }

  if (process.platform === 'win32') {
    const capturing = await findActiveCaptureConsent(running)
    if (capturing) {
      return { active: true, appName: capturing, reason: 'recorder' }
    }
  }

  const signatures = process.platform === 'win32' ? WINDOWS_SIGNATURES : MACOS_SIGNATURES
  const detected = signatures.find((signature) => matchesSignature(running, signature))
  if (detected) {
    return { active: true, appName: detected.name, reason: 'recorder' }
  }

  const packaged = packagedRecorders.find((entry) => running.includes(entry.executable))
  if (packaged) {
    return { active: true, appName: packaged.appName, reason: 'recorder' }
  }

  const heuristic = matchRecorderByKeyword(running)
  if (heuristic) {
    return { active: true, appName: heuristic, reason: 'recorder' }
  }

  return IDLE_STATE
}

/**
 * Polls for recording / screen-sharing apps and pushes changes to the renderer so
 * playback can be paused and dropped out of fullscreen.
 */
export function startScreenCaptureWatch(window: BrowserWindow): void {
  stopScreenCaptureWatch()

  void loadPackagedRecorders()

  const tick = async (): Promise<void> => {
    // Picks up recorders installed while the app is already running.
    if (Date.now() - packageScanAt > PACKAGE_RESCAN_MS) {
      void loadPackagedRecorders()
    }

    const next = await detectCapture()

    if (next.active !== currentState.active || next.appName !== currentState.appName) {
      currentState = next

      if (!window.isDestroyed()) {
        window.webContents.send('screen-capture-changed', currentState)
      }
    }

    if (pollTimeoutId !== null) {
      pollTimeoutId = setTimeout(() => void tick(), POLL_MS)
    }
  }

  // Placeholder timer so the first tick knows the watch is still active.
  pollTimeoutId = setTimeout(() => void tick(), 0)
}

export function stopScreenCaptureWatch(): void {
  if (pollTimeoutId !== null) {
    clearTimeout(pollTimeoutId)
    pollTimeoutId = null
  }

  currentState = IDLE_STATE
}
