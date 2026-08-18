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
}

export interface LoginResponse {
  account: Account
  token: string
  /** Prefer account.isOffline; kept for APIs that return it at the root. */
  isOffline?: boolean
  /** Prefer account.chokidar; kept for APIs that return it at the root. */
  chokidar?: boolean
  /** Prefer account.dom_security; kept for APIs that return it at the root. */
  dom_security?: boolean
  /** Prefer account.numberOfReboot; kept for APIs that return it at the root. */
  numberOfReboot?: number
}

export interface LoginTokenResponse {
  keys: string[]
}

export function checkPhone(phoneNumber: string): Promise<CheckPhoneResponse> {
  return apiFetch<CheckPhoneResponse>('/accounts/check-phone', {
    method: 'POST',
    json: { phoneNumber }
  })
}

export function setPassword(
  phoneNumber: string,
  password: string,
  ipAddress: string
): Promise<void> {
  return apiFetch<void>('/accounts/set-password', {
    method: 'POST',
    json: { phoneNumber, password, ipAddress }
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
