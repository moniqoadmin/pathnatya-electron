import type { Account } from '../api/accounts'
import { clearVideoKey } from './video-key'

/** Legacy localStorage keys — purged so older plaintext tokens do not linger. */
const LEGACY_TOKEN_KEY = 'pathnatya_token'
const LEGACY_ACCOUNT_KEY = 'pathnatya_account'
const LEGACY_LOGIN_TOKENS_KEY = 'pathnatya_login_tokens'

let sessionToken: string | null = null
let sessionAccount: Account | null = null
let loginTokens: string[] | null = null

function purgeLegacyStorage(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  localStorage.removeItem(LEGACY_ACCOUNT_KEY)
  localStorage.removeItem(LEGACY_LOGIN_TOKENS_KEY)
}

export function saveSession(token: string, account: Account): void {
  sessionToken = token
  sessionAccount = account
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

export function clearSession(): void {
  sessionToken = null
  sessionAccount = null
  loginTokens = null
  clearVideoKey()
  purgeLegacyStorage()
}

export function clearAllStorage(): void {
  clearSession()
}
