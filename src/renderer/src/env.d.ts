import type { Account } from './api/accounts'

export type OfflineLoginResult =
  | { ok: true; account: Account; token: string; loginTokens: string[] }
  | { ok: false; reason: 'needs_internet' | 'invalid' | 'tampered' }

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

export interface ScreenCaptureState {
  active: boolean
  appName: string
  appNames: string[]
  /** '' when playback is allowed. */
  reason: '' | 'recorder' | 'virtual-machine' | 'clock-mismatch' | 'always-on-top'
}

export interface VmState {
  virtual: boolean
  /** Display name of the hypervisor, e.g. "VMware". Empty when not virtual. */
  vendor: string
}

export interface ClockSkewState {
  mismatched: boolean
  skewMs: number | null
  checked: boolean
}

export interface ScanLogEntry {
  level: 'info' | 'found' | 'progress' | 'summary' | 'error'
  message: string
  engine: 'streaming' | null
  time: number
}

export interface TopmostWindowInfo {
  hwnd: string
  title: string
  app: string
  pid: number
  className: string
  alwaysOnTop: boolean
  pinned: boolean
  toolWindow: boolean
}

export interface TopmostScanResult {
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
  | 'app-data'

export interface AppPermission {
  id: PermissionId
  label: string
  description: string
  required: boolean
  granted: boolean
  howToEnable: string
}

export interface AppPermissionsStatus {
  platform: 'darwin' | 'win32' | 'other'
  allRequiredGranted: boolean
  permissions: AppPermission[]
}

export interface MachineLocation {
  timezone: string
  locale: string
  countryCode: string
}

export interface PcSpecs {
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

export interface MachineProfile {
  location: MachineLocation
  pcSpecs: PcSpecs
}

export interface PathnatyaAPI {
  getVersion: () => Promise<string>
  getPlatform: () => string
  isPackaged: () => Promise<boolean>
  getDeviceId: () => Promise<{ id: string; type: 'mac' | 'ip' | 'uuid' | '' }>
  getSystemMacAddress: () => Promise<string>
  getSystemIpAddress: () => Promise<string>
  getMachineProfile: () => Promise<MachineProfile>
  setVideoKey: (token: string) => Promise<void>
  clearVideoKey: () => Promise<void>
  setAppConfiguration: (config: {
    hlsSource: string
    allowedHosts: string[]
    videoFiles: string[]
  }) => Promise<void>
  clearAppConfiguration: () => Promise<void>
  prepareHlsVideo: (sourceUrl?: string) => Promise<{
    playlistUrl: string
    totalDurationSeconds: number
    segmentCount: number
    fromOffline: boolean
    expiresAt: string | null
  }>
  clearHlsVideo: () => Promise<void>
  getHlsOfflineStatus: () => Promise<HlsOfflineStatus>
  getHlsMemoryStatus: () => Promise<HlsOfflineStatus>
  downloadHlsVideo: (sourceUrl?: string) => Promise<HlsOfflineStatus>
  downloadHlsVideoMemory: (sourceUrl?: string) => Promise<HlsOfflineStatus>
  cancelHlsDownload: () => Promise<void>
  clearHlsOfflineVideo: () => Promise<void>
  clearHlsMemoryVideo: () => Promise<void>
  wipeDownloadedVideo: () => Promise<void>
  onHlsDownloadProgress: (callback: (progress: HlsOfflineStatus) => void) => () => void
  saveOfflineSession: (payload: {
    phoneNumber: string
    account: Account
    token: string
    loginTokens: string[]
    password: string
  }) => Promise<void>
  hasOfflineSession: (phoneNumber: string) => Promise<boolean>
  tryOfflineLogin: (phoneNumber: string, password: string) => Promise<OfflineLoginResult>
  isVideoTampered: () => Promise<boolean>
  markVideoTampered: () => Promise<void>
  clearVideoTamperLock: () => Promise<void>
  isOfflineCheckInRequired: () => Promise<boolean>
  renewOfflineCheckIn: () => Promise<boolean>
  syncTrustedTimeOnLogin: () => Promise<number | null>
  clearOfflineSession: () => Promise<void>
  onSessionInterrupted: (callback: () => void) => () => void
  onResetToLogin: (callback: () => void) => () => void
  onLogoutShortcut: (callback: () => void) => () => void
  onWindowBlur: (callback: () => void) => () => void
  setDriveScanEnabled: (enabled: boolean) => Promise<void>
  getScreenCaptureState: () => Promise<ScreenCaptureState>
  getTopmostWindows: () => Promise<TopmostScanResult>
  onScreenCaptureChanged: (callback: (state: ScreenCaptureState) => void) => () => void
  getVmState: () => Promise<VmState>
  getClockSkewState: () => Promise<ClockSkewState>
  getAppPermissions: () => Promise<AppPermissionsStatus>
  openPermissionSettings: (id?: PermissionId) => Promise<void>
  requestAccessibilityPermission: () => Promise<boolean>
  relaunchApp: () => Promise<void>
  onAppLog: (
    callback: (payload: {
      event: string
      tampered: boolean
      path?: string
      paths?: string[]
    }) => void
  ) => () => void
  onScanLog: (callback: (entry: ScanLogEntry) => void) => () => void
}

declare global {
  interface Window {
    pathnatya: PathnatyaAPI
  }
}

export {}
