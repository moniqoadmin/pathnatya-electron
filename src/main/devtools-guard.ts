import { app, type WebContents } from 'electron'

/** Chromium / Electron switches that open an inspector or CDP endpoint. */
export const FORBIDDEN_DEBUG_SWITCHES = [
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'debug',
  'debug-brk'
] as const

const FORBIDDEN_DEBUG_ARGV =
  /^(?:--)?(?:inspect(?:-brk|-port|-publish-uid)?|remote-debugging-(?:port|pipe|address)|debug(?:-brk)?)(?:=|$)/i

export function hasForbiddenDebugArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => FORBIDDEN_DEBUG_ARGV.test(arg))
}

export function hasForbiddenDebugSwitch(hasSwitch: (name: string) => boolean): boolean {
  return FORBIDDEN_DEBUG_SWITCHES.some((name) => hasSwitch(name))
}

/** True when packaged launch arguments would attach DevTools or a remote debugger. */
export function shouldRefusePackedDebugLaunch(
  argv: readonly string[],
  hasSwitch: (name: string) => boolean
): boolean {
  return hasForbiddenDebugArgv(argv) || hasForbiddenDebugSwitch(hasSwitch)
}

export function isDevToolsShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) {
    return false
  }

  const key = (input.key ?? '').toLowerCase()
  const code = (input.code ?? '').toLowerCase()

  if (key === 'f12' || code === 'f12') {
    return true
  }

  const inspectorKey =
    key === 'i' || key === 'j' || key === 'c' || code === 'keyi' || code === 'keyj' || code === 'keyc'
  if (!inspectorKey) {
    return false
  }

  // Windows / Linux: Ctrl+Shift+I/J/C
  if (input.control && input.shift && !input.alt && !input.meta) {
    return true
  }

  // macOS: Cmd+Option+I/J/C
  if (input.meta && input.alt && !input.control) {
    return true
  }

  return false
}

function hostWebContentsOf(contents: WebContents): WebContents | null {
  try {
    return contents.hostWebContents ?? null
  } catch {
    return null
  }
}

function closeDevTools(contents: WebContents): void {
  if (!contents.isDestroyed()) {
    contents.closeDevTools()
  }

  const host = hostWebContentsOf(contents)
  if (host && !host.isDestroyed()) {
    host.closeDevTools()
  }
}

function isDevToolsContents(contents: WebContents): boolean {
  try {
    const url = contents.getURL()
    return url.startsWith('devtools://') || url.startsWith('chrome-devtools://')
  } catch {
    return false
  }
}

/**
 * Packaged builds never keep DevTools open: every WebContents is watched, and a
 * DevTools guest window is closed as soon as Chromium creates it.
 */
export function installPackedDevToolsLockdown(
  onOpened?: (contents: WebContents) => void
): void {
  app.on('web-contents-created', (_event, contents) => {
    const shut = (): void => {
      onOpened?.(contents)
      closeDevTools(contents)
    }

    contents.on('devtools-opened', shut)

    const closeIfDevToolsGuest = (): void => {
      if (!isDevToolsContents(contents)) {
        return
      }

      shut()
      queueMicrotask(() => {
        try {
          if (!contents.isDestroyed()) {
            contents.close()
          }
        } catch {
          // The guest may already have been torn down by closeDevTools().
        }
      })
    }

    closeIfDevToolsGuest()
    contents.on('did-navigate', closeIfDevToolsGuest)
  })
}
