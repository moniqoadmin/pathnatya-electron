import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const SCAN_TIMEOUT_MS = 8000

export type TopmostWindow = {
  hwnd: string
  title: string
  app: string
  pid: number
  className: string
  alwaysOnTop: boolean
  /** Same as alwaysOnTop (WS_EX_TOPMOST) — matches the Window Inspector POC field. */
  pinned: boolean
  /** True when WS_EX_TOOLWINDOW is set (no taskbar button — common for overlays). */
  toolWindow: boolean
}

export type TopmostScanResult = {
  windows: TopmostWindow[]
  anyPinned: boolean
  supported: boolean
  platform: string
  capturedAt: string
  details?: string
  error?: string
}

/** Titles that are themselves inspectors / always-on-top tools we must not treat as threats. */
const IGNORED_TITLE_PATTERNS = [
  /window[\s_-]*inspector/i,
  /^pathnatya/i,
  /electron[\s_-]*window[\s_-]*inspector/i
]

/** Process names that own shell / input chrome (their TOPMOST windows are normal OS UI). */
const SHELL_PROCESS_NAMES = new Set([
  'explorer',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'searchhost',
  'searchapp',
  'textinputhost',
  'applicationframehost'
])

const SHELL_CLASS_NAMES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow',
  'MultitaskingViewFrame',
  'Xaml_WindowedPopupClass',
  'TaskListThumbnailWnd',
  'TaskListOverlayWnd',
  'ForegroundStaging',
  'Shell_InputSwitchTopLevelWindow',
  'Shell_Dim',
  'Shell_LightDismissOverlay',
  'Windows.UI.Composition.DesktopWindowContentBridge',
  'ThumbnailDeviceHelperWnd'
])

const FILE_EXPLORER_CLASSES = new Set(['CabinetWClass', 'ExploreWClass'])

/** Whether a window title should be ignored (Window Inspector, our own branded windows). */
export function shouldIgnoreTopmostTitle(title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) {
    return false
  }

  return IGNORED_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/** Shell / desktop chrome that can report TOPMOST without being a user pin. */
export function isShellWindowClass(className: string): boolean {
  if (SHELL_CLASS_NAMES.has(className)) {
    return true
  }

  // Win11 variants append suffixes (e.g. XamlExplorerHostIslandWindow_WASDK).
  return (
    className.startsWith('Shell_') ||
    className.startsWith('XamlExplorerHost') ||
    className.startsWith('ThumbnailDeviceHelper')
  )
}

export function isShellProcessWindow(app: string, className: string): boolean {
  const processName = app.trim().toLowerCase().replace(/\.exe$/i, '')
  if (!SHELL_PROCESS_NAMES.has(processName)) {
    return false
  }

  // Real File Explorer folders are not shell chrome.
  return !FILE_EXPLORER_CLASSES.has(className)
}

/** Untitled helper/tool HWNDs that report TOPMOST but are not real user windows. */
export function isUntitledNoiseWindow(win: Pick<TopmostWindow, 'title' | 'toolWindow'>): boolean {
  return win.title.trim().length === 0
}

/** Whether a row belongs in the inspector list / threat scan. */
export function isInspectableWindow(
  win: Pick<TopmostWindow, 'title' | 'app' | 'className' | 'toolWindow'>
): boolean {
  if (isUntitledNoiseWindow(win)) {
    return false
  }

  if (isShellWindowClass(win.className) || isShellProcessWindow(win.app, win.className)) {
    return false
  }

  return true
}

/** Display label for a scanned window (title, with process name when it adds context). */
export function formatTopmostWindowLabel(win: Pick<TopmostWindow, 'title' | 'app'>): string {
  const title = win.title.trim()
  const app = win.app.trim()
  if (title && app && title.toLowerCase() !== app.toLowerCase()) {
    return `${title} (${app})`
  }
  return title || app || 'an always-on-top app'
}

/**
 * Pinned always-on-top windows that are not our process and not ignored titles.
 */
export function listBlockingTopmostWindows(
  windows: TopmostWindow[],
  excludePid: number
): TopmostWindow[] {
  return windows.filter((win) => {
    if (!win.alwaysOnTop) {
      return false
    }

    if (win.pid === excludePid) {
      return false
    }

    if (!isInspectableWindow(win)) {
      return false
    }

    if (shouldIgnoreTopmostTitle(win.title)) {
      return false
    }

    return true
  })
}

/**
 * Picks the first pinned window that is not our process and not an ignored title.
 * Returns a display name for the UI gate.
 */
export function pickBlockingTopmostApp(
  windows: TopmostWindow[],
  excludePid: number
): string | null {
  const [win] = listBlockingTopmostWindows(windows, excludePid)
  return win ? formatTopmostWindowLabel(win) : null
}

/** Parses `hwnd|title|app|pid|className|alwaysOnTop|toolWindow` lines from the scanner. */
export function parseTopmostWindowsDump(stdout: string): TopmostWindow[] {
  const windows: TopmostWindow[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const parts = trimmed.split('|')
    if (parts.length < 7) {
      continue
    }

    const [hwnd, title, app, pidText, className, topmostText, toolText] = parts
    const pid = Number(pidText)
    const alwaysOnTop = topmostText === '1'
    windows.push({
      hwnd: hwnd ?? '',
      title: (title ?? '').replace(/\u001f/g, '|'),
      app: (app ?? '').replace(/\u001f/g, '|'),
      pid: Number.isFinite(pid) ? pid : 0,
      className: (className ?? '').replace(/\u001f/g, '|'),
      alwaysOnTop,
      pinned: alwaysOnTop,
      toolWindow: toolText === '1'
    })
  }

  return windows
}

/**
 * Enumerates visible top-level windows and reports WS_EX_TOPMOST via PowerShell + user32.
 * Windows-only; elsewhere returns an empty unsupported snapshot.
 *
 * Tool windows are included when they are TOPMOST — floating overlays often use
 * WS_EX_TOOLWINDOW. Shell chrome is filtered out of the returned list.
 */
export async function listWindowsWithTopmost(excludePid = 0): Promise<TopmostScanResult> {
  const capturedAt = new Date().toISOString()
  const platform = process.platform

  if (platform !== 'win32') {
    return {
      windows: [],
      anyPinned: false,
      supported: false,
      platform,
      capturedAt,
      details: 'Always-on-top window scan is only supported on Windows.'
    }
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class PathnatyaTopmostEnum {
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOPMOST = 0x00000008;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
  static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
  static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);

  static int ReadExStyle(IntPtr hWnd) {
    try {
      if (IntPtr.Size == 8) {
        return unchecked((int)GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64());
      }
    } catch {}
    return GetWindowLong32(hWnd, GWL_EXSTYLE);
  }

  static string Sanitize(string value) {
    if (string.IsNullOrEmpty(value)) return "";
    return value.Replace("|", " ").Replace(((char)13).ToString(), " ").Replace(((char)10).ToString(), " ");
  }

  public static string Run(uint excludePid) {
    var sb = new StringBuilder();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int ex = ReadExStyle(hWnd);
      bool topmost = (ex & WS_EX_TOPMOST) != 0;
      bool tool = (ex & WS_EX_TOOLWINDOW) != 0;
      // Skip ordinary tool windows; keep TOPMOST overlays (common for pin-on-top apps).
      if (tool && !topmost) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (excludePid != 0 && pid == excludePid) return true;
      var titleSb = new StringBuilder(512);
      GetWindowText(hWnd, titleSb, titleSb.Capacity);
      // Untitled TOPMOST helpers (IME, tray balloons, etc.) are noise — skip early.
      if (titleSb.Length == 0) return true;
      var classSb = new StringBuilder(256);
      GetClassName(hWnd, classSb, classSb.Capacity);
      string app = "";
      try {
        var proc = Process.GetProcessById((int)pid);
        app = proc.ProcessName ?? "";
      } catch {}
      sb.Append(hWnd.ToInt64()).Append('|');
      sb.Append(Sanitize(titleSb.ToString())).Append('|');
      sb.Append(Sanitize(app)).Append('|');
      sb.Append((int)pid).Append('|');
      sb.Append(Sanitize(classSb.ToString())).Append('|');
      sb.Append(topmost ? '1' : '0').Append('|');
      sb.Append(tool ? '1' : '0').Append((char)10);
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
[PathnatyaTopmostEnum]::Run([uint32]${excludePid})
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: SCAN_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }
    )

    const raw = parseTopmostWindowsDump(stdout)
    // Drop shell chrome and untitled helper HWNDs (IME / tray / balloon noise).
    const windows = raw.filter((win) => isInspectableWindow(win))
    const anyPinned = windows.some((win) => win.alwaysOnTop)

    return {
      windows,
      anyPinned,
      supported: true,
      platform,
      capturedAt
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[topmost-guard] scan failed:', message)
    return {
      windows: [],
      anyPinned: false,
      supported: true,
      platform,
      capturedAt,
      error: message
    }
  }
}

/**
 * Other always-on-top windows, if any. Ignores our PID and Window Inspector.
 * On scan failure returns [] so a flaky PowerShell run does not lock playback.
 */
export async function findPinnedAlwaysOnTopWindows(
  excludePid = process.pid
): Promise<TopmostWindow[]> {
  const snapshot = await listWindowsWithTopmost(excludePid)
  if (snapshot.error || !snapshot.supported) {
    return []
  }

  const blocking = listBlockingTopmostWindows(snapshot.windows, excludePid)
  if (blocking.length > 0) {
    console.log(
      '[topmost-guard] always-on-top windows:',
      blocking.map((win) => ({
        title: win.title,
        app: win.app,
        pid: win.pid,
        hwnd: win.hwnd,
        className: win.className
      }))
    )
  }

  return blocking
}

/**
 * Display name of another always-on-top app, if any. Ignores our PID and Window Inspector.
 * On scan failure returns null so a flaky PowerShell run does not lock playback.
 */
export async function findPinnedAlwaysOnTopApp(
  excludePid = process.pid
): Promise<string | null> {
  const [win] = await findPinnedAlwaysOnTopWindows(excludePid)
  return win ? formatTopmostWindowLabel(win) : null
}
