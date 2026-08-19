import { apiFetch } from './client'

export interface CheckPhoneResponse {
  exists: boolean
  needsPassword: boolean
}

export interface Account {
  id: string
  phoneNumber: string
  setPassword: boolean
  status: string
  country: string
  sanghat: string
  jilha: string
  taluka: string
  group: string
  kendra: string
  sanchalakName: string
  ipAddress: string
  metadata: Record<string, unknown>
  lastLoginTime: string
  createdAt: string
  updatedAt: string
  /** When true, this account may download the video for offline playback. */
  isOffline?: boolean
  /** Drive streaming scan is always on after login (backend flag ignored). */
  chokidar?: boolean
  /** Video-player DOM integrity watch is always on (backend flag ignored). */
  dom_security?: boolean
  /** Max offline OS reboots before an online check-in is required. */
  numberOfReboot?: number
  /** When true, show the logout button in the app top bar. */
  logoutButton?: boolean
  /** Copied from login `team.teamNumber` for the video watermark. */
  teamNumber?: number
}

export interface LoginTeam {
  teamNumber: number
}

export interface LoginResponse {
  account: Account
  token: string
  team?: LoginTeam
  /** Prefer account.isOffline; kept for APIs that return it at the root. */
  isOffline?: boolean
  /** Prefer account.chokidar; kept for APIs that return it at the root. */
  chokidar?: boolean
  /** Prefer account.dom_security; kept for APIs that return it at the root. */
  dom_security?: boolean
  /** Prefer account.numberOfReboot; kept for APIs that return it at the root. */
  numberOfReboot?: number
  /** Prefer account.logoutButton; kept for APIs that return it at the root. */
  logoutButton?: boolean
}

export interface LoginTokenResponse {
  keys: string[]
}

export function checkPhone(phoneNumber: string, ipAddress: string): Promise<CheckPhoneResponse> {
  console.log('check-phone ipAddress:', ipAddress)
  return apiFetch<CheckPhoneResponse>('/accounts/check-phone', {
    method: 'POST',
    json: { phoneNumber, ipAddress }
  })
}

export interface SetPasswordResponse {
  id: string
  phoneNumber: string
  teams: unknown[]
  teamNumber: number
}

export interface SetPasswordLocation {
  timezone: string
  locale: string
  countryCode: string
}

export interface SetPasswordPcSpecs {
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

export function setPassword(
  phoneNumber: string,
  password: string,
  ipAddress: string,
  extras?: { location?: SetPasswordLocation; pcSpecs?: SetPasswordPcSpecs }
): Promise<SetPasswordResponse> {
  const metadata = {
    ...(extras?.location ? { location: extras.location } : {}),
    ...(extras?.pcSpecs ? { pcSpecs: extras.pcSpecs } : {})
  }

  return apiFetch<SetPasswordResponse>('/accounts/set-password', {
    method: 'POST',
    json: {
      phoneNumber,
      password,
      ipAddress,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    }
  })
}

export function login(
  phoneNumber: string,
  password: string,
  ipAddress: string
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/accounts/login', {
    method: 'POST',
    json: { phoneNumber, password, ipAddress }
  })
}

export async function getLoginTokens(authToken: string): Promise<string[]> {
  const data = await apiFetch<LoginTokenResponse>('/accounts/login-token', {
    authToken
  })
  return data.keys
}
