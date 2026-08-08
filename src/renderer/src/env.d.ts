import type { Account } from './api/accounts'

export interface OfflineLoginResult {
  account: Account
  token: string
  loginTokens: string[]
}

export interface HlsOfflineStatus {
  available: boolean
  downloading: boolean
  completed: number
  total: number
  percent: number
  expiresAt: string | null
  downloadedAt: string | null
  bytesDownloaded: number
}

export interface PathnatyaAPI {
  getVersion: () => string
  getPlatform: () => string
  isPackaged: () => Promise<boolean>
  getDeviceId: () => Promise<{ id: string; type: 'mac' | 'ip' | 'uuid' | '' }>
  getSystemMacAddress: () => Promise<string>
  getSystemIpAddress: () => Promise<string>
  setVideoKey: (token: string) => Promise<void>
  clearVideoKey: () => Promise<void>
  prepareHlsVideo: (sourceUrl?: string) => Promise<{
    playlistUrl: string
    totalDurationSeconds: number
    segmentCount: number
    fromOffline: boolean
    expiresAt: string | null
  }>
  clearHlsVideo: () => Promise<void>
  getHlsOfflineStatus: () => Promise<HlsOfflineStatus>
  downloadHlsVideo: (sourceUrl?: string) => Promise<HlsOfflineStatus>
  cancelHlsDownload: () => Promise<void>
  clearHlsOfflineVideo: () => Promise<void>
  onHlsDownloadProgress: (callback: (progress: HlsOfflineStatus) => void) => () => void
  saveOfflineSession: (payload: {
    phoneNumber: string
    account: Account
    token: string
    loginTokens: string[]
    password: string
  }) => Promise<void>
  hasOfflineSession: (phoneNumber: string) => Promise<boolean>
  tryOfflineLogin: (phoneNumber: string, password: string) => Promise<OfflineLoginResult | null>
  clearOfflineSession: () => Promise<void>
  onSessionInterrupted: (callback: () => void) => () => void
  onWindowBlur: (callback: () => void) => () => void
}

declare global {
  interface Window {
    pathnatya: PathnatyaAPI
  }
}

export {}
