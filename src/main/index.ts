import { ipcMain, app, BrowserWindow, shell, protocol, session } from 'electron'
import { execFile } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'
import os from 'os'
import {
  cancelHlsOfflineDownload,
  clearPreparedHls,
  deleteOfflineVideo,
  downloadHlsVideoForOffline,
  getDecryptedSegment,
  getOfflineVideoStatus,
  getRewrittenPlaylist,
  prepareHlsVideo
} from './hls-service'
import { clearHlsKey, setHlsKey } from './hls-key'
import { purgeExpiredOfflineVideo } from './hls-offline'
import { getRuntimeValueA, getRuntimeValueB } from './runtime-values'
import {
  clearOfflineSession,
  hasOfflineSession,
  saveOfflineSession,
  tryOfflineLogin,
  type OfflineSessionPayload
} from './offline-session'
import { enforceDesktopLaptopOnly } from './platform-guard'
import {
  getScreenCaptureState,
  startScreenCaptureWatch,
  stopScreenCaptureWatch
} from './capture-guard'
import { minimizeOtherApps } from './minimize-others'

const isDev = !app.isPackaged

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

const ZERO_MAC = '00:00:00:00:00:00'
const VIRTUAL_IFACE_RE =
  /^(lo|loopback|awdl|llw|utun|bridge|vmenet|vmnet|vboxnet|docker|veth|br-|ap|p2p|bluetooth)/i

const execFileAsync = promisify(execFile)

type DeviceIdentifier = { id: string; type: 'mac' | 'ip' | 'uuid' | '' }

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4 || String(family) === '4'
}

function isUsableMac(mac: string | undefined): boolean {
  return Boolean(mac && mac !== ZERO_MAC)
}

/** Prefer real Wi‑Fi/Ethernet adapters; deprioritize VPN/virtual (esp. important on macOS). */
function interfaceScore(name: string): number {
  if (VIRTUAL_IFACE_RE.test(name)) {
    return 0
  }

  if (/^en\d+$/i.test(name)) {
    return 100
  }

  if (/^eth\d+$/i.test(name) || /^wlan\d+$/i.test(name)) {
    return 95
  }

  if (/wi-?fi|wireless|ethernet|local area connection/i.test(name)) {
    return 90
  }

  return 40
}

function getSystemMacAddress(): string {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ mac: string; score: number }> = []

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) {
      continue
    }

    const baseScore = interfaceScore(name)
    if (baseScore === 0) {
      continue
    }

    for (const net of nets) {
      if (net.internal || !isUsableMac(net.mac)) {
        continue
      }

      const score = baseScore + (isIpv4Family(net.family) ? 10 : 0)
      candidates.push({ mac: net.mac.toUpperCase(), score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.mac ?? ''
}

function getSystemIpAddress(): string {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ address: string; score: number }> = []

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) {
      continue
    }

    const baseScore = interfaceScore(name)
    if (baseScore === 0) {
      continue
    }

    for (const net of nets) {
      if (net.internal || !isIpv4Family(net.family) || !net.address) {
        continue
      }

      candidates.push({ address: net.address, score: baseScore })
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

function interruptSession(mainWindow: BrowserWindow): void {
  clearPreparedHls()
  clearHlsKey()

  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-interrupted')
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
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
    minimizeOtherApps()
  })

  if (!isDev) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools()
    })
  }

  startScreenCaptureWatch(mainWindow)
  mainWindow.on('closed', stopScreenCaptureWatch)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  protocol.handle('pathnatya', async (request) => {
    const url = new URL(request.url)

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
          const message = error instanceof Error ? error.message : 'Unable to read playlist.'
          return new Response(message, { status: 500 })
        }
      }

      if (url.pathname.startsWith('/segment/')) {
        const segmentIndex = Number.parseInt(url.pathname.slice('/segment/'.length), 10)

        if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
          return new Response('Invalid segment.', { status: 400 })
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
          const message = error instanceof Error ? error.message : 'Unable to read video segment.'
          return new Response(message, { status: 500 })
        }
      }
    }

    return new Response('Not found', { status: 404 })
  })

  ipcMain.handle('get-device-id', () => getDeviceIdentifier())
  ipcMain.handle('get-system-mac', () => getSystemMacAddress())
  ipcMain.handle('get-system-ip', () => getSystemIpAddress())

  ipcMain.handle('is-packaged', () => app.isPackaged)

  ipcMain.handle('get-screen-capture-state', () => getScreenCaptureState())

  // Nothing in the app captures a screen, so refuse every getDisplayMedia request.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({})
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'fullscreen')
  })

  ipcMain.handle('set-video-key', (_event, token: string) => {
    setHlsKey(String(token ?? ''))
  })

  ipcMain.handle('clear-video-key', () => {
    clearHlsKey()
  })

  ipcMain.handle('prepare-hls-video', async (_event, sourceUrl?: string) => {
    return prepareHlsVideo(sourceUrl?.trim() || undefined)
  })

  ipcMain.handle('clear-hls-video', () => {
    clearPreparedHls()
  })

  ipcMain.handle('get-hls-offline-status', async () => {
    return getOfflineVideoStatus()
  })

  ipcMain.handle('download-hls-video', async (event, sourceUrl?: string) => {
    return downloadHlsVideoForOffline((progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('hls-download-progress', progress)
      }
    }, sourceUrl?.trim() || undefined)
  })

  ipcMain.handle('cancel-hls-download', () => {
    cancelHlsOfflineDownload()
  })

  ipcMain.handle('clear-hls-offline-video', async () => {
    cancelHlsOfflineDownload()
    await deleteOfflineVideo()
  })

  ipcMain.handle('save-offline-session', async (_event, payload: OfflineSessionPayload) => {
    await saveOfflineSession(payload)
  })

  ipcMain.handle('has-offline-session', async (_event, phoneNumber: string) => {
    return hasOfflineSession(String(phoneNumber ?? ''))
  })

  ipcMain.handle('try-offline-login', async (_event, phoneNumber: string, password: string) => {
    return tryOfflineLogin(String(phoneNumber ?? ''), String(password ?? ''))
  })

  ipcMain.handle('clear-offline-session', async () => {
    await clearOfflineSession()
  })

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.pathnatya.app')
  }

  const allowed = await enforceDesktopLaptopOnly()
  if (!allowed) {
    return
  }

  console.log('runtime value A:', getRuntimeValueA())
  console.log('runtime value B:', getRuntimeValueB())

  await purgeExpiredOfflineVideo()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  clearPreparedHls()
  clearHlsKey()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
