import { ipcMain, app, BrowserWindow, Menu, shell, protocol, session, net } from 'electron'
import { execFile } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'
import os from 'os'
import {
  cancelHlsMemoryDownload,
  cancelHlsOfflineDownload,
  clearMemoryHls,
  clearPreparedHls,
  deleteOfflineVideo,
  wipeDownloadedVideo,
  downloadHlsVideoForOffline,
  downloadHlsVideoToMemory,
  getDecryptedSegment,
  getMemoryVideoStatus,
  getOfflineVideoStatus,
  getRewrittenPlaylist,
  prepareHlsVideo
} from './hls-service'
import { clearHlsKey, setHlsKey } from './hls-key'
import {
  clearHlsAppConfiguration,
  loadHlsAppConfiguration,
  saveHlsAppConfiguration
} from './hls-config'
import { purgeExpiredOfflineVideo } from './hls-offline'
import { getKnownBindingMacs, getSystemMacAddress } from './device-mac'
import { getRuntimeValueA, getRuntimeValueB } from './runtime-values'
import {
  isOfflineCheckInRequired,
  renewOfflineCheckIn
} from './offline-checkin'
import {
  clearOfflineSession,
  hasOfflineSession,
  saveOfflineSession,
  tryOfflineLogin,
  type OfflineSessionPayload
} from './offline-session'
import {
  applyOfflineRebootProtection,
  getClockSkewVerdict,
  getRebootProtectionState,
  loadTrustedTime,
  startTrustedTimePeriodicSync,
  syncTrustedTime,
  syncTrustedTimeOnLogin
} from './trusted-time'
import { enforceDesktopLaptopOnly } from './platform-guard'
import { getMachineProfile } from './machine-profile'
import {
  getScreenCaptureState,
  startScreenCaptureWatch,
  stopScreenCaptureWatch
} from './capture-guard'
import { listWindowsWithTopmost } from './topmost-guard'
import { detectVirtualMachine, getVirtualMachineVerdict } from './vm-guard'
import { minimizeOtherApps } from './minimize-others'
import { createTray, destroyTray, hideWindowToTray, revealWindow } from './tray'
import { startDriveScanLoop, stopDriveScanLoop } from './drive-scanner'
import { startAsarWatch, stopAsarWatch } from './asar-watcher'
import {
  cleanupPermissionProbe,
  getAppPermissionsStatus,
  openPermissionSettings,
  relaunchApp,
  requestAccessibilityPermission,
  type PermissionId
} from './permissions-guard'
import { API_BASE } from '../shared/api-config'

const isDev = !app.isPackaged

// The app keeps running in the tray after its window is closed, so a second launch
// must hand focus back to the existing instance instead of starting a new one.
// Skipped in dev: electron-vite restarts the main process on every edit, and the
// outgoing process can still hold the lock, which would silently kill the new one.
const hasInstanceLock = isDev || app.requestSingleInstanceLock()

if (!hasInstanceLock) {
  app.quit()
}

let isQuitting = false

app.on('before-quit', () => {
  isQuitting = true
})

app.on('second-instance', () => {
  const [existingWindow] = BrowserWindow.getAllWindows()
  if (existingWindow) {
    revealWindow(existingWindow)
  }
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pathnatya',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

function rendererContentSecurityPolicy(): string {
  const apiOrigin = new URL(API_BASE).origin
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' pathnatya: blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' pathnatya: ${apiOrigin} https://speed.cloudflare.com http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*`
  ].join('; ')
}

function applyRendererContentSecurityPolicy(): void {
  const policy = rendererContentSecurityPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
      callback({})
      return
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}

const execFileAsync = promisify(execFile)

type DeviceIdentifier = { id: string; type: 'mac' | 'ip' | 'uuid' | '' }

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4 || String(family) === '4'
}

function getSystemIpAddress(): string {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ address: string; score: number }> = []

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) {
      continue
    }

    // Skip obvious virtual adapters; MAC scoring lives in device-mac.ts.
    if (
      /^(lo|loopback|awdl|llw|utun|bridge|vmenet|vmnet|vboxnet|docker|veth|br-|ap|p2p|bluetooth)/i.test(
        name
      )
    ) {
      continue
    }

    let score = 40
    if (/^en\d+$/i.test(name)) {
      score = 100
    } else if (/^eth\d+$/i.test(name) || /^wlan\d+$/i.test(name)) {
      score = 95
    } else if (/wi-?fi|wireless|ethernet|local area connection/i.test(name)) {
      score = 90
    }

    for (const net of nets) {
      if (net.internal || !isIpv4Family(net.family) || !net.address) {
        continue
      }

      candidates.push({ address: net.address, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address ?? ''
}

/** Hardware UUID from IOPlatformExpertDevice (stable across network changes). */
async function getMacOsPlatformUuid(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** Windows: MAC only (literal "macAddress" if unavailable). macOS: IOPlatformUUID. */
async function getDeviceIdentifier(): Promise<DeviceIdentifier> {
  if (process.platform === 'darwin') {
    const uuid = await getMacOsPlatformUuid()
    if (uuid) {
      return { id: uuid, type: 'uuid' }
    }
    return { id: '', type: '' }
  }

  const mac = getSystemMacAddress()
  if (mac) {
    return { id: mac, type: 'mac' }
  }

  return { id: 'macAddress', type: 'mac' }
}

/**
 * Reason to refuse video work, or null when playback is allowed. Content protection and
 * recorder detection both live inside the guest, while the host records the guest
 * display from outside it, so a VM never gets a decrypted segment at all — pausing
 * the player alone would leave the plaintext sitting in the guest.
 */
function videoBlockedReason(): string | null {
  const vm = getVirtualMachineVerdict()
  if (vm.virtual) {
    return (
      `845 : Video playback is blocked because ${vm.vendor} was detected. ` +
      'Run Pathnatya on a physical Windows or macOS laptop.'
    )
  }

  const clock = getClockSkewVerdict()
  if (clock.mismatched) {
    return (
      '2904 : Video playback is blocked because this computer\'s clock does not match ' +
      'server GMT time. Turn on automatic date & time, then restart Pathnatya.'
    )
  }

  return null
}

function interruptSession(mainWindow: BrowserWindow): void {
  clearPreparedHls()
  clearMemoryHls()
  clearHlsKey()

  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-interrupted')
  }
}

function notifyAppLog(
  mainWindow: BrowserWindow,
  event: 'DEVTOOLS_SHORTCUT' | 'DEVTOOLS_OPENED',
  tampered: boolean
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-log', { event, tampered })
  }
}

function isDevToolsShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) {
    return false
  }

  const key = input.key.toLowerCase()
  if (key === 'f12') {
    return true
  }

  const inspectorKey = key === 'i' || key === 'j' || key === 'c'
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

function isLogoutShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) {
    return false
  }

  if (input.key.toLowerCase() !== 'h') {
    return false
  }

  // Windows / Linux: Ctrl+Shift+H
  if (input.control && input.shift && !input.alt && !input.meta) {
    return true
  }

  // macOS: Cmd+Shift+H
  if (input.meta && input.shift && !input.alt && !input.control) {
    return true
  }

  return false
}

function isResetShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) {
    return false
  }

  if (input.key.toLowerCase() !== 'r') {
    return false
  }

  // Windows / Linux: Ctrl+Shift+R
  if (input.control && input.shift && !input.alt && !input.meta) {
    return true
  }

  // macOS: Cmd+Shift+R
  if (input.meta && input.shift && !input.alt && !input.control) {
    return true
  }

  return false
}

function isAltClick(mouse: Electron.MouseInputEvent): boolean {
  if (mouse.type !== 'mouseDown' && mouse.type !== 'mouseUp' && mouse.type !== 'contextMenu') {
    return false
  }

  return Boolean(mouse.modifiers?.includes('alt'))
}

function registerInputGuards(mainWindow: BrowserWindow): void {
  let resetInProgress = false

  mainWindow.webContents.on('before-mouse-event', (event, mouse) => {
    if (isAltClick(mouse)) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (isDevToolsShortcut(input)) {
      if (!isDev) {
        event.preventDefault()
        notifyAppLog(mainWindow, 'DEVTOOLS_SHORTCUT', true)
      }
      return
    }

    if (isLogoutShortcut(input)) {
      event.preventDefault()
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('logout-shortcut')
      }
      return
    }

    if (!isResetShortcut(input) || resetInProgress) {
      return
    }

    event.preventDefault()
    resetInProgress = true
    cancelHlsOfflineDownload()
    cancelHlsMemoryDownload()
    clearPreparedHls()
    clearMemoryHls()
    clearHlsKey()

    void Promise.all([deleteOfflineVideo(), clearOfflineSession()])
      .catch((error) => {
        console.error('Unable to fully reset local video data:', error)
      })
      .finally(() => {
        resetInProgress = false
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('reset-to-login')
        }
      })
  })
}

function applyApplicationMenu(): void {
  if (isDev) {
    return
  }

  if (process.platform === 'darwin') {
    // macOS always shows the system menu bar. Drop File/View (Reload, DevTools,
    // fullscreen) and keep only the app menu plus Edit so login fields still
    // support Cut/Copy/Paste/Select All.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    )
    return
  }

  // Windows/Linux: remove the window menu bar entirely, including Alt reveal.
  Menu.setApplicationMenu(null)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    resizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    title: 'Pathnatya 2026',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: isDev
    }
  })

  // Excludes the window from screen capture at OS level: WDA_EXCLUDEFROMCAPTURE on
  // Windows and NSWindowSharingNone on macOS. Screen shares and recorders see the
  // desktop behind the window instead of the video.
  const applyContentProtection = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(true)
    }
  }

  applyContentProtection()

  // Windows can drop the capture-exclusion flag when the window is recreated for a
  // fullscreen or display change, so it is re-applied on every transition.
  mainWindow.on('enter-full-screen', applyContentProtection)
  mainWindow.on('leave-full-screen', applyContentProtection)
  mainWindow.on('enter-html-full-screen', applyContentProtection)
  mainWindow.on('leave-html-full-screen', applyContentProtection)
  mainWindow.on('show', applyContentProtection)
  mainWindow.on('restore', applyContentProtection)

  // A non-resizable window has its min/max size pinned to the current bounds, which
  // also blocks it from growing to fill the screen. Resizing is re-enabled only while
  // fullscreen so video playback still works, and locked again on the way out.
  const allowResizeWhileFullscreen = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setResizable(true)
    }
  }

  const lockSizeAfterFullscreen = (): void => {
    setTimeout(() => {
      if (!mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
        mainWindow.setResizable(false)
        mainWindow.setMaximizable(false)
      }
    }, 0)
  }

  mainWindow.on('enter-full-screen', allowResizeWhileFullscreen)
  mainWindow.on('enter-html-full-screen', allowResizeWhileFullscreen)
  mainWindow.on('leave-full-screen', lockSizeAfterFullscreen)
  mainWindow.on('leave-html-full-screen', lockSizeAfterFullscreen)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (isDev) {
      mainWindow.webContents.openDevTools()
    }
  })

  // OS-level focus loss (Alt-Tab / Cmd-Tab / click another app) and minimise/hide.
  // More reliable than renderer window.blur while HTML fullscreen is active.
  const notifyAway = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-blur')
    }
  }

  mainWindow.on('blur', notifyAway)
  mainWindow.on('minimize', notifyAway)
  mainWindow.on('hide', notifyAway)

  // When Pathnatya is focused, tuck other apps away so only this window stays in view.
  mainWindow.on('focus', () => {
    minimizeOtherApps(() => !mainWindow.isDestroyed() && mainWindow.isFocused())
  })

  if (!isDev) {
    mainWindow.webContents.on('devtools-opened', () => {
      notifyAppLog(mainWindow, 'DEVTOOLS_OPENED', true)
      mainWindow.webContents.closeDevTools()
    })
  }

  createTray(mainWindow)

  // Closing the window parks the app in the tray; only an explicit quit tears it down.
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    hideWindowToTray(mainWindow)
  })

  startScreenCaptureWatch(mainWindow)
  startAsarWatch(mainWindow, (window, asarPath) => {
    void wipeDownloadedVideo()
      .catch((error) => {
        console.error('Unable to wipe downloaded video after asar tamper:', error)
      })
      .finally(() => {
        if (window.isDestroyed()) {
          return
        }
        window.webContents.send('app-log', {
          event: 'FILES_TAMPERED',
          tampered: true,
          paths: [asarPath]
        })
      })
  })
  mainWindow.on('closed', () => {
    stopAsarWatch()
    stopScreenCaptureWatch()
    stopDriveScanLoop()
    destroyTray()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  registerInputGuards(mainWindow)

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) {
    return
  }

  protocol.handle('pathnatya', async (request) => {
    const url = new URL(request.url)

    const blocked = videoBlockedReason()
    if (blocked) {
      return new Response(blocked, { status: 403 })
    }

    if (url.hostname === 'hls') {
      if (url.pathname === '/playlist.m3u8') {
        try {
          return new Response(getRewrittenPlaylist(), {
            status: 200,
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': 'no-store',
              // hls.js loads over fetch, so the renderer origin needs CORS here.
              'Access-Control-Allow-Origin': '*'
            }
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : '804 : Unable to read playlist.'
          return new Response(message, { status: 500 })
        }
      }

      if (url.pathname.startsWith('/segment/')) {
        const segmentIndex = Number.parseInt(url.pathname.slice('/segment/'.length), 10)

        if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
          return new Response('5196 : Invalid segment.', { status: 400 })
        }

        try {
          const plaintext = await getDecryptedSegment(segmentIndex)

          // Copy so evicting the cached plaintext cannot corrupt an in-flight response.
          return new Response(Buffer.from(plaintext) as unknown as BodyInit, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp2t',
              'Content-Length': String(plaintext.length),
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*'
            }
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : '2637 : Unable to read video segment.'
          return new Response(message, { status: 500 })
        }
      }
    }

    return new Response('4041 : Not found', { status: 404 })
  })

  ipcMain.handle('get-device-id', () => getDeviceIdentifier())
  ipcMain.handle('get-system-mac', () => getSystemMacAddress())
  ipcMain.handle('get-system-ip', () => getSystemIpAddress())
  ipcMain.handle('get-machine-profile', () => getMachineProfile())

  ipcMain.handle('is-packaged', () => app.isPackaged)
  ipcMain.handle('get-version', () => app.getVersion())

  ipcMain.handle('get-screen-capture-state', () => getScreenCaptureState())

  // Window Inspector popover: full snapshot of visible top-level windows + TOPMOST.
  ipcMain.handle('get-topmost-windows', () => listWindowsWithTopmost(0))

  ipcMain.handle('get-vm-state', () => getVirtualMachineVerdict())

  ipcMain.handle('get-clock-skew-state', () => getClockSkewVerdict())

  ipcMain.handle('get-app-permissions', () => getAppPermissionsStatus())

  ipcMain.handle('open-permission-settings', async (_event, id?: PermissionId) => {
    await openPermissionSettings(id)
  })

  ipcMain.handle('request-accessibility-permission', () => requestAccessibilityPermission())

  ipcMain.handle('relaunch-app', () => {
    relaunchApp()
  })

  // Drive streaming scan — started after login (renderer always enables it).
  ipcMain.handle('set-drive-scan-enabled', (event, enabled: boolean) => {
    if (!enabled) {
      stopDriveScanLoop()
      return
    }

    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && !window.isDestroyed()) {
      startDriveScanLoop(window)
    }
  })

  // Nothing in the app captures a screen, so refuse every getDisplayMedia request.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({})
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'fullscreen')
  })

  // Not VM-guarded: login must still complete so the VM_DETECTED log reaches the
  // server. The key is inert here anyway — nothing below will decrypt a segment.
  ipcMain.handle('set-video-key', (_event, token: string) => {
    setHlsKey(String(token ?? ''))
  })

  ipcMain.handle('clear-video-key', () => {
    clearHlsKey()
  })

  ipcMain.handle('set-app-configuration', async (_event, payload: unknown) => {
    await saveHlsAppConfiguration(payload)
  })

  ipcMain.handle('clear-app-configuration', () => {
    clearHlsAppConfiguration()
  })

  ipcMain.handle('prepare-video', async (_event, sourceUrl?: string) => {
    const blocked = videoBlockedReason()
    if (blocked) {
      throw new Error(blocked)
    }

    return prepareHlsVideo(sourceUrl?.trim() || undefined)
  })

  ipcMain.handle('clear-hls-video', () => {
    // Playback session only — keep the in-memory package across logout.
    clearPreparedHls()
  })

  ipcMain.handle('get-hls-offline-status', async () => {
    return getOfflineVideoStatus()
  })

  ipcMain.handle('get-hls-memory-status', () => {
    return getMemoryVideoStatus()
  })

  ipcMain.handle('download-hls-video', async (event, sourceUrl?: string) => {
    const blocked = videoBlockedReason()
    if (blocked) {
      throw new Error(blocked)
    }

    return downloadHlsVideoForOffline((progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('hls-download-progress', progress)
      }
    }, sourceUrl?.trim() || undefined)
  })

  ipcMain.handle('download-hls-video-memory', async (event, sourceUrl?: string) => {
    const blocked = videoBlockedReason()
    if (blocked) {
      throw new Error(blocked)
    }

    return downloadHlsVideoToMemory((progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('hls-download-progress', progress)
      }
    }, sourceUrl?.trim() || undefined)
  })

  ipcMain.handle('cancel-hls-download', () => {
    cancelHlsOfflineDownload()
    cancelHlsMemoryDownload()
  })

  ipcMain.handle('clear-hls-memory-video', () => {
    clearMemoryHls()
  })

  ipcMain.handle('wipe-downloaded-video', async () => {
    await wipeDownloadedVideo()
  })

  ipcMain.handle('clear-hls-offline-video', async () => {
    // Offline logout / online-only account cleanup must not erase a package the
    // user cannot re-download until they are back online.
    if (net.isOnline() === false) {
      console.log('[hls-offline] skip clear while offline')
      return
    }

    cancelHlsOfflineDownload()
    await deleteOfflineVideo()
  })

  ipcMain.handle('save-offline-session', async (_event, payload: OfflineSessionPayload) => {
    try {
      await syncTrustedTime()
    } catch (error) {
      console.warn('[trusted-time] sync before offline session save failed', error)
    }
    await saveOfflineSession(payload)
  })

  ipcMain.handle('has-offline-session', async (_event, phoneNumber: string) => {
    return hasOfflineSession(String(phoneNumber ?? ''))
  })

  ipcMain.handle('try-offline-login', async (_event, phoneNumber: string, password: string) => {
    return tryOfflineLogin(String(phoneNumber ?? ''), String(password ?? ''))
  })

  ipcMain.handle('is-offline-checkin-required', () => isOfflineCheckInRequired())

  ipcMain.handle('renew-offline-checkin', () => renewOfflineCheckIn())

  ipcMain.handle('sync-trusted-time-on-login', () => syncTrustedTimeOnLogin())

  ipcMain.handle('clear-offline-session', async () => {
    await clearOfflineSession()
  })

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.pathnatya.app')
  }

  // Force direct connection: ignore Windows Registry / system proxy configurations
  await session.defaultSession.setProxy({
    mode: 'direct'
  })

  // Header CSP blocks Vite's inline React-refresh preamble in dev (meta CSP does not,
  // because Vite prepends that script before the meta tag). Pin origins only when packaged.
  if (!isDev) {
    applyRendererContentSecurityPolicy()
  }

  const allowed = await enforceDesktopLaptopOnly()
  if (!allowed) {
    return
  }

  // Resolved before the first window so no video request can race the verdict.
  // The app still runs on a VM (login, offline reset, support) — only video is denied.
  const vm = await detectVirtualMachine()
  if (vm.virtual) {
    console.warn(`[vm-guard] ${vm.vendor} detected — video playback is blocked`)
    await deleteOfflineVideo()
  }

  // Record the MAC while an adapter is still up: once the machine goes offline the OS
  // stops reporting it, and the offline video package is sealed against it.
  await getKnownBindingMacs()
  await loadHlsAppConfiguration()

  console.log('runtime value A:', getRuntimeValueA())
  console.log('runtime value B:', getRuntimeValueB())

  await loadTrustedTime()
  try {
    const serverNow = await syncTrustedTime()
    const clock = getClockSkewVerdict()
    console.log('[trusted-time] synced', new Date(serverNow).toISOString())
    if (clock.mismatched) {
      console.warn(
        `[trusted-time] clock mismatch — |server−local|=${clock.skewMs}ms; video blocked`
      )
    }
  } catch (error) {
    console.warn('[trusted-time] startup sync failed; using last known offset if any', error)
    await applyOfflineRebootProtection()
    const reboot = getRebootProtectionState()
    if (reboot.penaltyMs > 0) {
      console.warn(
        `[trusted-time] offline reboot protection active; penalty=${reboot.penaltyMs}ms, wall clock ignored`
      )
    }
  }

  startTrustedTimePeriodicSync()

  await purgeExpiredOfflineVideo()
  await cleanupPermissionProbe()

  applyApplicationMenu()
  createWindow()

  app.on('activate', () => {
    const [existingWindow] = BrowserWindow.getAllWindows()
    if (existingWindow) {
      revealWindow(existingWindow)
    } else {
      createWindow()
    }
  })
})

// Only reached on an explicit quit, since closing the window hides it to the tray.
app.on('window-all-closed', () => {
  clearPreparedHls()
  clearMemoryHls()
  clearHlsKey()
  destroyTray()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
