import { spawn, type ChildProcess } from 'child_process'
import { systemPreferences } from 'electron'

const DEBOUNCE_MS = 200
const TIMEOUT_MS = 8000
const COOLDOWN_MS = 1000

// Minimising the foreground window makes Windows activate whatever is next in the
// Z-order, which is often us again, so a run can trigger the focus event that
// schedules the next run. The deadline and the cooldown keep that loop bounded and
// guarantee the in-flight latch is always released, even if the child never exits.
const HARD_DEADLINE_MS = TIMEOUT_MS + 2000

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let queued = false
let lastRunAt = 0
let isStillFocused: (() => boolean) | null = null
let activeChild: ChildProcess | null = null
let macPermissionPrompted = false

function ensureMacAccessibilityPermission(): boolean {
  if (process.platform !== 'darwin') {
    return true
  }

  const shouldPrompt = !macPermissionPrompted
  macPermissionPrompted = true

  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(shouldPrompt)
    if (!trusted) {
      console.warn(
        '[mac-permissions] Accessibility permission is required to hide other applications. ' +
          'Enable Pathnatya 2026 in System Settings > Privacy & Security > Accessibility, then restart the app.'
      )
    }
    return trusted
  } catch (error) {
    console.warn('[mac-permissions] Unable to check Accessibility permission:', error)
    return false
  }
}

/**
 * Minimizes (Windows) or hides (macOS) other apps when Pathnatya gains focus.
 * Desktop / taskbar / shell windows are left alone. Fire-and-forget; failures are ignored.
 *
 * `stillFocused` is re-checked right before the OS call so a fast Alt-Tab away does
 * not end up minimising the app the user just switched to.
 */
export function minimizeOtherApps(stillFocused?: () => boolean): void {
  isStillFocused = stillFocused ?? null

  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runMinimizeOtherApps()
  }, DEBOUNCE_MS)
}

function scheduleRetry(delayMs: number): void {
  if (debounceTimer) {
    return
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runMinimizeOtherApps()
  }, delayMs)
}

async function runMinimizeOtherApps(): Promise<void> {
  if (running) {
    queued = true
    return
  }

  if (isStillFocused && !isStillFocused()) {
    queued = false
    return
  }

  const cooldownLeft = COOLDOWN_MS - (Date.now() - lastRunAt)
  if (cooldownLeft > 0) {
    queued = false
    scheduleRetry(cooldownLeft)
    return
  }

  running = true
  lastRunAt = Date.now()

  try {
    if (process.platform === 'win32') {
      await withHardDeadline(minimizeOthersWindows(process.pid))
    } else if (process.platform === 'darwin') {
      if (!ensureMacAccessibilityPermission()) {
        return
      }
      await withHardDeadline(hideOthersMac(process.pid))
    }
  } catch (error) {
    console.warn('[minimize-others] Unable to hide other applications:', error)
  } finally {
    running = false
    if (queued) {
      queued = false
      void runMinimizeOtherApps()
    }
  }
}

/**
 * Resolves once the work settles or the deadline passes, whichever comes first. Hitting
 * the deadline means the child outlived its own kill timer, so the tree is taken down
 * before the in-flight latch is released: two overlapping sweeps would otherwise
 * enumerate and minimise windows against each other's foreground check.
 */
function withHardDeadline(work: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (activeChild) {
        killTree(activeChild)
      }
      resolve()
    }, HARD_DEADLINE_MS)
    timer.unref()

    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }

    work.then(done, done)
  })
}

/**
 * Runs a helper and resolves when it exits, is killed, or fails to start. stdio is
 * detached: PowerShell's `Add-Type` compiles through csc.exe, and an inherited pipe
 * held open by that grandchild would leave this promise pending forever.
 */
function runHelper(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let child: ChildProcess

    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve()
      return
    }

    activeChild = child

    let settled = false
    const killTimer = setTimeout(() => killTree(child), TIMEOUT_MS)
    killTimer.unref()

    const finish = (): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(killTimer)

      if (activeChild === child) {
        activeChild = null
      }

      resolve()
    }

    child.once('error', finish)
    child.once('close', finish)
  })
}

/** Terminating only the shell leaves compiler grandchildren running, so take the tree. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return
  }

  try {
    if (process.platform === 'win32') {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      }).once('error', () => {})
      return
    }

    child.kill('SIGKILL')
  } catch {
    // Nothing left to do if the process is already gone.
  }
}

async function minimizeOthersWindows(keepPid: number): Promise<void> {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class PathnatyaMinOther {
  const int SW_MINIMIZE = 6;
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);

  static readonly string[] ShellClasses = {
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
    "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
    "MultitaskingViewFrame", "Xaml_WindowedPopupClass", "TaskListThumbnailWnd",
    "TaskListOverlayWnd", "ForegroundStaging", "Shell_InputSwitchTopLevelWindow",
    "Shell_Dim", "Shell_LightDismissOverlay",
    "Windows.UI.Composition.DesktopWindowContentBridge"
  };

  static bool IsFileExplorer(string cls) {
    return cls == "CabinetWClass" || cls == "ExploreWClass";
  }

  static bool IsShellClass(string cls) {
    foreach (var known in ShellClasses) { if (cls == known) return true; }
    return false;
  }

  static HashSet<uint> ShellPids() {
        foreach (var proc in Process.GetProcessesByName(name)) { pids.Add((uint)proc.Id); }
      } catch {}
    }
    return pids;
  }

  public static void Run(uint keepPid) {
    uint foregroundPid;
    GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
    if (foregroundPid != keepPid) return;

    var shellPids = ShellPids();

    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == keepPid) return true;
      var sb = new StringBuilder(256);
      GetClassName(hWnd, sb, sb.Capacity);
      var cls = sb.ToString();
      if (IsShellClass(cls)) return true;
      if (shellPids.Contains(pid) && !IsFileExplorer(cls)) return true;
      ShowWindow(hWnd, SW_MINIMIZE);
      return true;
    }, IntPtr.Zero);
  }
}
"@
[PathnatyaMinOther]::Run(${keepPid})
`.trim()

  await runHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

async function hideOthersMac(keepPid: number): Promise<void> {
  const script = `
tell application "System Events"
  try
    set keepName to name of first process whose unix id is ${keepPid}
    set visible of (every process whose background only is false and visible is true and name is not keepName) to false
  end try
end tell
`.trim()

  await runHelper('osascript', ['-e', script])
}
