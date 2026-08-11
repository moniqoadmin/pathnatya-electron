import { promises as fs } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto'

const OFFLINE_SESSION_FILE = 'offline-session.dat'
/** Matches offline video availability so users can log in and watch for 7 days. */
export const OFFLINE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
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
}

export interface OfflineSessionPayload {
  phoneNumber: string
  account: OfflineAccount
  token: string
  loginTokens: string[]
  password: string
}

export interface OfflineLoginResult {
  account: OfflineAccount
  token: string
  loginTokens: string[]
}

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
  const savedAtMs = Date.parse(savedAt)
  if (Number.isNaN(savedAtMs)) {
    return true
  }

  return Date.now() - savedAtMs > OFFLINE_SESSION_TTL_MS
}

async function readStoredSession(): Promise<StoredOfflineSession | null> {
  try {
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
  if (!/^\d{10}$/.test(phoneNumber)) {
    throw new Error('Invalid phone number for offline session.')
  }

  if (!payload.password) {
    throw new Error('Password is required to save an offline session.')
  }

  if (!Array.isArray(payload.loginTokens) || payload.loginTokens.length === 0) {
    throw new Error('Login tokens are required to save an offline session.')
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
    savedAt: new Date().toISOString()
  }

  const sealed = seal(JSON.stringify(stored))
  await fs.writeFile(getSessionPath(), sealed)
}

export async function hasOfflineSession(phoneNumber: string): Promise<boolean> {
  const stored = await readStoredSession()
  return Boolean(stored && stored.phoneNumber === phoneNumber.trim())
}

export async function tryOfflineLogin(
  phoneNumber: string,
  password: string
): Promise<OfflineLoginResult | null> {
  const stored = await readStoredSession()
  if (!stored || stored.phoneNumber !== phoneNumber.trim() || !password) {
    return null
  }

  const salt = Buffer.from(stored.passwordSalt, 'base64')
  const expected = Buffer.from(stored.passwordHash, 'base64')
  const actual = hashPassword(password, salt)

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null
  }

  return {
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
