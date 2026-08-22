import { promises as fs } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto'
import { getHlsAppConfiguration, loadHlsAppConfiguration } from './hls-config'
import { isVideoTampered } from './video-tamper-lock'
import { isOfflineCheckInRequired } from './offline-checkin'
import {
  getTrustedNowDate,
  isTrustedExpired,
  isTrustedTtlExpired,
  loadTrustedTime,
  setNumberOfRebootFromAccount
} from './trusted-time'
import { FALLBACK_VIDEO_TTL_MS } from '../shared/app-configuration'
import { isValidPhoneNumber } from '../shared/phone-number'

const OFFLINE_SESSION_FILE = 'offline-session.dat'
/** Fallback when END_DATE is omitted: 15 days from the last online login. */
export const OFFLINE_SESSION_TTL_MS = FALLBACK_VIDEO_TTL_MS
const PBKDF2_ITERATIONS = 120_000
const PBKDF2_KEY_LENGTH = 32
const PBKDF2_DIGEST = 'sha256'

export interface OfflineAccount {
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
  isOffline?: boolean
  chokidar?: boolean
  dom_security?: boolean
  numberOfReboot?: number
  logoutButton?: boolean
  teamNumber?: number
}

export interface OfflineSessionPayload {
  phoneNumber: string
  account: OfflineAccount
  token: string
  loginTokens: string[]
  password: string
}

export type OfflineLoginResult =
  | { ok: true; account: OfflineAccount; token: string; loginTokens: string[] }
  | { ok: false; reason: 'needs_internet' | 'invalid' | 'tampered' }

interface StoredOfflineSession {
  phoneNumber: string
  account: OfflineAccount
  token: string
  loginTokens: string[]
  passwordSalt: string
  passwordHash: string
  savedAt: string
}

function getSessionPath(): string {
  return join(app.getPath('userData'), OFFLINE_SESSION_FILE)
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST)
}

function seal(plaintext: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext)
  }

  return Buffer.from(plaintext, 'utf8')
}

function unseal(payload: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(payload)
  }

  return payload.toString('utf8')
}

function isExpired(savedAt: string): boolean {
  const endDate = getHlsAppConfiguration()?.endDate
  if (endDate) {
    return isTrustedExpired(endDate)
  }

  return isTrustedTtlExpired(savedAt, OFFLINE_SESSION_TTL_MS)
}

async function readStoredSession(): Promise<StoredOfflineSession | null> {
  try {
    await loadTrustedTime()
    await loadHlsAppConfiguration()
    const encrypted = await fs.readFile(getSessionPath())
    const parsed = JSON.parse(unseal(encrypted)) as StoredOfflineSession

    if (
      !parsed?.phoneNumber ||
      !parsed.account ||
      !parsed.token ||
      !Array.isArray(parsed.loginTokens) ||
      !parsed.passwordSalt ||
      !parsed.passwordHash ||
      !parsed.savedAt
    ) {
      return null
    }

    if (isExpired(parsed.savedAt)) {
      await clearOfflineSession()
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export async function saveOfflineSession(payload: OfflineSessionPayload): Promise<void> {
  const phoneNumber = payload.phoneNumber.trim()
  if (!isValidPhoneNumber(phoneNumber)) {
    throw new Error('578 : Invalid phone number for offline session.')
  }

  // Online-only accounts must not get a local login fallback.
  if (!payload.account.isOffline) {
    return
  }

  if (!payload.password) {
    throw new Error('9247 : Password is required to save an offline session.')
  }

  if (!Array.isArray(payload.loginTokens) || payload.loginTokens.length === 0) {
    throw new Error('361 : Login tokens are required to save an offline session.')
  }

  const salt = randomBytes(16)
  const passwordHash = hashPassword(payload.password, salt)

  const stored: StoredOfflineSession = {
    phoneNumber,
    account: payload.account,
    token: payload.token,
    loginTokens: [...payload.loginTokens],
    passwordSalt: salt.toString('base64'),
    passwordHash: passwordHash.toString('base64'),
    savedAt: getTrustedNowDate().toISOString()
  }

  const sealed = seal(JSON.stringify(stored))
  await fs.writeFile(getSessionPath(), sealed)
  await setNumberOfRebootFromAccount(payload.account)
}

export async function hasOfflineSession(phoneNumber: string): Promise<boolean> {
  if (await isVideoTampered()) {
    return false
  }

  const stored = await readStoredSession()
  return Boolean(
    stored && stored.phoneNumber === phoneNumber.trim() && Boolean(stored.account.isOffline)
  )
}

export async function tryOfflineLogin(
  phoneNumber: string,
  password: string
): Promise<OfflineLoginResult> {
  if (await isVideoTampered()) {
    return { ok: false, reason: 'tampered' }
  }

  const stored = await readStoredSession()
  if (!stored || stored.phoneNumber !== phoneNumber.trim() || !password) {
    return { ok: false, reason: 'invalid' }
  }

  const salt = Buffer.from(stored.passwordSalt, 'base64')
  const expected = Buffer.from(stored.passwordHash, 'base64')
  const actual = hashPassword(password, salt)

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'invalid' }
  }

  // Online-only accounts must authenticate against the server.
  if (!stored.account.isOffline) {
    return { ok: false, reason: 'invalid' }
  }

  // Downloaded offline video must re-verify server time every 2 days. Keep the
  // package; only refuse local login until the next successful sync.
  if (await isOfflineCheckInRequired()) {
    return { ok: false, reason: 'needs_internet' }
  }

  await loadHlsAppConfiguration()

  return {
    ok: true,
    account: stored.account,
    token: stored.token,
    loginTokens: [...stored.loginTokens]
  }
}

export async function clearOfflineSession(): Promise<void> {
  try {
    await fs.unlink(getSessionPath())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
  }
}
