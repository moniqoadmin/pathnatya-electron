import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const DEBOUNCE_MS = 200
const TIMEOUT_MS = 8000

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let queued = false

/**
 * Minimizes (Windows) or hides (macOS) other apps when Pathnatya gains focus.
 * Desktop / taskbar / shell windows are left alone. Fire-and-forget; failures are ignored.
 */
export function minimizeOtherApps(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runMinimizeOtherApps()
  }, DEBOUNCE_MS)
}

async function runMinimizeOtherApps(): Promise<void> {
  if (running) {
    queued = true
    return
  }

  running = true
  try {
    if (process.platform === 'win32') {
      await minimizeOthersWindows(process.pid)
    } else if (process.platform === 'darwin') {
      await hideOthersMac(process.pid)
    }
  } catch {
    // Best-effort UX aid; never block the main window on OS scripting failures.
  } finally {
    running = false
    if (queued) {
      queued = false
      void runMinimizeOtherApps()
    }
  }
}

async function minimizeOthersWindows(keepPid: number): Promise<void> {
  // Enumerate top-level windows and SW_MINIMIZE anything visible that is not us or the shell.
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PathnatyaMinOther {
  const int SW_MINIMIZE = 6;
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
  static bool IsShell(string cls) {
    return cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd"
      || cls == "Shell_SecondaryTrayWnd" || cls == "NotifyIconOverflowWindow"
      || cls == "Windows.UI.Core.CoreWindow";
  }
  public static void Run(uint keepPid) {
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == keepPid) return true;
      var sb = new StringBuilder(256);
      GetClassName(hWnd, sb, sb.Capacity);
      if (IsShell(sb.ToString())) return true;
      ShowWindow(hWnd, SW_MINIMIZE);
      return true;
    }, IntPtr.Zero);
  }
}
"@
[PathnatyaMinOther]::Run(${keepPid})
`.trim()

  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true }
  )
}

async function hideOthersMac(keepPid: number): Promise<void> {
  // Equivalent to macOS "Hide Others": leave our app visible, hide every other foreground app.
  const script = `
tell application "System Events"
  try
    set keepName to name of first process whose unix id is ${keepPid}
    set visible of (every process whose background only is false and visible is true and name is not keepName) to false
  end try
end tell
`.trim()

  await execFileAsync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS
  })
}
