import { contextBridge, ipcRenderer } from 'electron'

const API_VERSION = '1.0.0'

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
}

const API = {
  getVersion: () => API_VERSION,
  getPlatform: () => process.platform,
  isPackaged: () => ipcRenderer.invoke('is-packaged') as Promise<boolean>,
  getDeviceId: () =>
    ipcRenderer.invoke('get-device-id') as Promise<{ id: string; type: 'mac' | 'ip' | 'uuid' | '' }>,
  getSystemMacAddress: () => ipcRenderer.invoke('get-system-mac') as Promise<string>,
  getSystemIpAddress: () => ipcRenderer.invoke('get-system-ip') as Promise<string>,
  setVideoKey: (token: string) => ipcRenderer.invoke('set-video-key', token) as Promise<void>,
  clearVideoKey: () => ipcRenderer.invoke('clear-video-key') as Promise<void>,
  prepareHlsVideo: (sourceUrl?: string) =>
    ipcRenderer.invoke('prepare-hls-video', sourceUrl) as Promise<{
      playlistUrl: string
      totalDurationSeconds: number
      segmentCount: number
      fromOffline: boolean
      expiresAt: string | null
    }>,
  clearHlsVideo: () => ipcRenderer.invoke('clear-hls-video') as Promise<void>,
  getHlsOfflineStatus: () =>
    ipcRenderer.invoke('get-hls-offline-status') as Promise<HlsOfflineStatus>,
  downloadHlsVideo: (sourceUrl?: string) =>
    ipcRenderer.invoke('download-hls-video', sourceUrl) as Promise<HlsOfflineStatus>,
  cancelHlsDownload: () => ipcRenderer.invoke('cancel-hls-download') as Promise<void>,
  clearHlsOfflineVideo: () => ipcRenderer.invoke('clear-hls-offline-video') as Promise<void>,
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
      account: unknown
      token: string
      loginTokens: string[]
    } | null>,
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
  onWindowBlur: (callback: () => void) => {
    const handler = (): void => {
      callback()
    }

    ipcRenderer.on('window-blur', handler)
    return () => {
      ipcRenderer.removeListener('window-blur', handler)
    }
  },
  getScreenCaptureState: () =>
    ipcRenderer.invoke('get-screen-capture-state') as Promise<ScreenCaptureState>,
  onScreenCaptureChanged: (callback: (state: ScreenCaptureState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ScreenCaptureState): void => {
      callback(state)
    }

    ipcRenderer.on('screen-capture-changed', handler)
    return () => {
      ipcRenderer.removeListener('screen-capture-changed', handler)
    }
  }
}

contextBridge.exposeInMainWorld('pathnatya', API)
