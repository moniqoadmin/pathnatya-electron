import { contextBridge, ipcRenderer } from 'electron'

export type HlsOfflineStatus = {
  available: boolean
  downloading: boolean
  completed: number
  total: number
  percent: number
  expiresAt: string | null
  downloadedAt: string | null
  bytesDownloaded: number
}

export type ScreenCaptureState = {
  active: boolean
  appName: string
  reason: '' | 'recorder' | 'virtual-machine' | 'clock-mismatch' | 'always-on-top'
}

export type VmState = {
  virtual: boolean
  vendor: string
}

export type ClockSkewState = {
  mismatched: boolean
  skewMs: number | null
  checked: boolean
}

export type ScanLogEntry = {
  level: 'info' | 'found' | 'progress' | 'summary' | 'error'
  message: string
  engine: 'streaming' | null
  time: number
}

export type TopmostWindowInfo = {
  hwnd: string
  title: string
  app: string
  pid: number
  className: string
  alwaysOnTop: boolean
  pinned: boolean
  toolWindow: boolean
}

export type TopmostScanResult = {
  windows: TopmostWindowInfo[]
  anyPinned: boolean
  supported: boolean
  platform: string
  capturedAt: string
  details?: string
  error?: string
}

export type PermissionId =
  | 'files'
  | 'accessibility'
  | 'folders'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'music-library'
  | 'photo-library'

export type AppPermission = {
  id: PermissionId
  label: string
  description: string
  required: boolean
  granted: boolean
  howToEnable: string
}

export type AppPermissionsStatus = {
  platform: 'darwin' | 'win32' | 'other'
  allRequiredGranted: boolean
  permissions: AppPermission[]
}

export type MachineLocation = {
  timezone: string
  locale: string
  countryCode: string
}

export type PcSpecs = {
  platform: string
  arch: string
  osRelease: string
  osVersion: string
  ramGb: number
  ramBytes: number
  cpuModel: string
  cpuCores: number
  hostname: string
  screenWidth: number
  screenHeight: number
  appVersion: string
}

export type MachineProfile = {
  location: MachineLocation
  pcSpecs: PcSpecs
}

const API = {
  getVersion: () => ipcRenderer.invoke('get-version') as Promise<string>,
  getPlatform: () => process.platform,
  isPackaged: () => ipcRenderer.invoke('is-packaged') as Promise<boolean>,
  getDeviceId: () =>
    ipcRenderer.invoke('get-device-id') as Promise<{ id: string; type: 'mac' | 'ip' | 'uuid' | '' }>,
  getSystemMacAddress: () => ipcRenderer.invoke('get-system-mac') as Promise<string>,
  getSystemIpAddress: () => ipcRenderer.invoke('get-system-ip') as Promise<string>,
  getMachineProfile: () => ipcRenderer.invoke('get-machine-profile') as Promise<MachineProfile>,
  setVideoKey: (token: string) => ipcRenderer.invoke('set-video-key', token) as Promise<void>,
  clearVideoKey: () => ipcRenderer.invoke('clear-video-key') as Promise<void>,
  setAppConfiguration: (config: {
    hlsSource: string
    allowedHosts: string[]
    videoFiles: string[]
  }) => ipcRenderer.invoke('set-app-configuration', config) as Promise<void>,
  clearAppConfiguration: () => ipcRenderer.invoke('clear-app-configuration') as Promise<void>,
  prepareHlsVideo: (sourceUrl?: string) =>
    ipcRenderer.invoke('prepare-video', sourceUrl) as Promise<{
      playlistUrl: string
      totalDurationSeconds: number
      segmentCount: number
      fromOffline: boolean
      expiresAt: string | null
    }>,
  clearHlsVideo: () => ipcRenderer.invoke('clear-hls-video') as Promise<void>,
  getHlsOfflineStatus: () =>
    ipcRenderer.invoke('get-hls-offline-status') as Promise<HlsOfflineStatus>,
  getHlsMemoryStatus: () =>
    ipcRenderer.invoke('get-hls-memory-status') as Promise<HlsOfflineStatus>,
  downloadHlsVideo: (sourceUrl?: string) =>
    ipcRenderer.invoke('download-hls-video', sourceUrl) as Promise<HlsOfflineStatus>,
  downloadHlsVideoMemory: (sourceUrl?: string) =>
    ipcRenderer.invoke('download-hls-video-memory', sourceUrl) as Promise<HlsOfflineStatus>,
  cancelHlsDownload: () => ipcRenderer.invoke('cancel-hls-download') as Promise<void>,
  clearHlsOfflineVideo: () => ipcRenderer.invoke('clear-hls-offline-video') as Promise<void>,
  clearHlsMemoryVideo: () => ipcRenderer.invoke('clear-hls-memory-video') as Promise<void>,
  wipeDownloadedVideo: () => ipcRenderer.invoke('wipe-downloaded-video') as Promise<void>,
  onHlsDownloadProgress: (callback: (progress: HlsOfflineStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: HlsOfflineStatus): void => {
      callback(progress)
    }

    ipcRenderer.on('hls-download-progress', handler)
    return () => {
      ipcRenderer.removeListener('hls-download-progress', handler)
    }
  },
  saveOfflineSession: (payload: {
    phoneNumber: string
    account: unknown
    token: string
    loginTokens: string[]
    password: string
  }) => ipcRenderer.invoke('save-offline-session', payload) as Promise<void>,
  hasOfflineSession: (phoneNumber: string) =>
    ipcRenderer.invoke('has-offline-session', phoneNumber) as Promise<boolean>,
  tryOfflineLogin: (phoneNumber: string, password: string) =>
    ipcRenderer.invoke('try-offline-login', phoneNumber, password) as Promise<{
      ok: true
      account: unknown
      token: string
      loginTokens: string[]
    } | { ok: false; reason: 'needs_internet' | 'invalid' | 'tampered' }>,
  isVideoTampered: () => ipcRenderer.invoke('is-video-tampered') as Promise<boolean>,
  markVideoTampered: () => ipcRenderer.invoke('mark-video-tampered') as Promise<void>,
  clearVideoTamperLock: () => ipcRenderer.invoke('clear-video-tamper-lock') as Promise<void>,
  isOfflineCheckInRequired: () =>
    ipcRenderer.invoke('is-offline-checkin-required') as Promise<boolean>,
  renewOfflineCheckIn: () => ipcRenderer.invoke('renew-offline-checkin') as Promise<boolean>,
  syncTrustedTimeOnLogin: () => ipcRenderer.invoke('sync-trusted-time-on-login') as Promise<number | null>,
  clearOfflineSession: () => ipcRenderer.invoke('clear-offline-session') as Promise<void>,
  onSessionInterrupted: (callback: () => void) => {
    const handler = (): void => {
      callback()
    }

    ipcRenderer.on('session-interrupted', handler)
    return () => {
      ipcRenderer.removeListener('session-interrupted', handler)
    }
  },
  onResetToLogin: (callback: () => void) => {
    const handler = (): void => {
      callback()
    }

    ipcRenderer.on('reset-to-login', handler)
    return () => {
      ipcRenderer.removeListener('reset-to-login', handler)
    }
  },
  onLogoutShortcut: (callback: () => void) => {
    const handler = (): void => {
      callback()
    }

    ipcRenderer.on('logout-shortcut', handler)
    return () => {
      ipcRenderer.removeListener('logout-shortcut', handler)
    }
  },
  onWindowBlur: (callback: () => void) => {
    const handler = (): void => {
      callback()
    }

    ipcRenderer.on('window-blur', handler)
    return () => {
      ipcRenderer.removeListener('window-blur', handler)
    }
  },
  setDriveScanEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-drive-scan-enabled', enabled) as Promise<void>,
  getScreenCaptureState: () =>
    ipcRenderer.invoke('get-screen-capture-state') as Promise<ScreenCaptureState>,
  getTopmostWindows: () =>
    ipcRenderer.invoke('get-topmost-windows') as Promise<TopmostScanResult>,
  getVmState: () => ipcRenderer.invoke('get-vm-state') as Promise<VmState>,
  getClockSkewState: () =>
    ipcRenderer.invoke('get-clock-skew-state') as Promise<ClockSkewState>,
  getAppPermissions: () =>
    ipcRenderer.invoke('get-app-permissions') as Promise<AppPermissionsStatus>,
  openPermissionSettings: (id?: PermissionId) =>
    ipcRenderer.invoke('open-permission-settings', id) as Promise<void>,
  requestAccessibilityPermission: () =>
    ipcRenderer.invoke('request-accessibility-permission') as Promise<boolean>,
  relaunchApp: () => ipcRenderer.invoke('relaunch-app') as Promise<void>,
  onScreenCaptureChanged: (callback: (state: ScreenCaptureState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ScreenCaptureState): void => {
      callback(state)
    }

    ipcRenderer.on('screen-capture-changed', handler)
    return () => {
      ipcRenderer.removeListener('screen-capture-changed', handler)
    }
  },
  onAppLog: (
    callback: (payload: {
      event: string
      tampered: boolean
      path?: string
      paths?: string[]
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        event: string
        tampered: boolean
        path?: string
        paths?: string[]
      }
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('app-log', handler)
    return () => {
      ipcRenderer.removeListener('app-log', handler)
    }
  },
  onScanLog: (callback: (entry: ScanLogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: ScanLogEntry): void => {
      callback(entry)
    }

    ipcRenderer.on('scan-log', handler)
    return () => {
      ipcRenderer.removeListener('scan-log', handler)
    }
  }
}

contextBridge.exposeInMainWorld('pathnatya', API)
