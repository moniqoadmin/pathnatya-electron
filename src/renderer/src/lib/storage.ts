import type { Account } from '../api/accounts'
import { clearAppConfiguration } from './app-configuration'
import { clearVideoKey } from './video-key'

/** Legacy localStorage keys — purged so older plaintext tokens do not linger. */
const LEGACY_TOKEN_KEY = 'pathnatya_token'
const LEGACY_ACCOUNT_KEY = 'pathnatya_account'
const LEGACY_LOGIN_TOKENS_KEY = 'pathnatya_login_tokens'

let sessionToken: string | null = null
let sessionAccount: Account | null = null
/** Primitive snapshot — not tied to the mutable account object used by React. */
let watermarkPhoneNumber: string | null = null
let loginTokens: string[] | null = null

function purgeLegacyStorage(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  localStorage.removeItem(LEGACY_ACCOUNT_KEY)
  localStorage.removeItem(LEGACY_LOGIN_TOKENS_KEY)
}

export function saveSession(token: string, account: Account): void {
  sessionToken = token
  sessionAccount = account
  watermarkPhoneNumber = String(account.phoneNumber ?? '')
  purgeLegacyStorage()
}

export function saveLoginTokens(tokens: string[]): void {
  loginTokens = [...tokens]
  purgeLegacyStorage()
}

export function getLoginTokens(): string[] | null {
  return loginTokens ? [...loginTokens] : null
}

export function getSession(): { token: string; account: Account } | null {
  if (!sessionToken || !sessionAccount) {
    return null
  }

  return { token: sessionToken, account: sessionAccount }
}

/** Phone number frozen at login for watermarking; immune to account object edits. */
export function getWatermarkPhoneNumber(): string | null {
  return watermarkPhoneNumber
}

export function clearSession(): void {
  sessionToken = null
  sessionAccount = null
  watermarkPhoneNumber = null
  loginTokens = null
  clearVideoKey()
  clearAppConfiguration()
  purgeLegacyStorage()
}

export function clearAllStorage(): void {
  clearSession()
}
