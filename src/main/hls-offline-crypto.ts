import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'

/** Magic: PathNatya Offline Format */
export const OFFLINE_AT_REST_MAGIC = Buffer.from('PNOF')
export const OFFLINE_AT_REST_VERSION = 1

const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const HEADER_LENGTH = OFFLINE_AT_REST_MAGIC.length + 1 + NONCE_LENGTH
const KEY_FILE = 'hls-offline.atrest'

/**
 * Layout on disk:
 *   MAGIC(4) | VERSION(1) | NONCE(12) | CIPHERTEXT | AUTH_TAG(16)
 */
function keyFilePath(): string {
  return join(app.getPath('userData'), KEY_FILE)
}

function fallbackKey(): Buffer {
  return createHash('sha256')
    .update('pathnatya:hls-offline:at-rest:v1')
    .update(process.platform)
    .digest()
}

function sealKey(keyHex: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(keyHex)
  }

  return Buffer.from(keyHex, 'utf8')
}

function unsealKey(payload: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(payload)
  }

  return payload.toString('utf8')
}

async function getOrCreatePackageKey(): Promise<Buffer> {
  const path = keyFilePath()

  try {
    const sealed = await fs.readFile(path)
    const key = Buffer.from(unsealKey(sealed), 'hex')
    if (key.length === KEY_LENGTH) {
      return key
    }
  } catch {
    // Missing or corrupt — create a new key below.
  }

  try {
    const key = randomBytes(KEY_LENGTH)
    await fs.writeFile(path, sealKey(key.toString('hex')))
    return key
  } catch {
    // Cannot persist (e.g. tests without a writable userData) — deterministic fallback.
    return fallbackKey()
  }
}

export function isAtRestPayload(payload: Buffer): boolean {
  return (
    payload.length >= HEADER_LENGTH + AUTH_TAG_LENGTH &&
    payload.subarray(0, OFFLINE_AT_REST_MAGIC.length).equals(OFFLINE_AT_REST_MAGIC)
  )
}

/** Encrypt plaintext and prepend the custom at-rest header. */
export async function encryptAtRest(plaintext: Buffer): Promise<Buffer> {
  const key = await getOrCreatePackageKey()
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([
    OFFLINE_AT_REST_MAGIC,
    Buffer.from([OFFLINE_AT_REST_VERSION]),
    nonce,
    ciphertext,
    tag
  ])
}

/**
 * Strip the custom header and decrypt in memory.
 * Throws if the header is missing/invalid or authentication fails.
 */
export async function decryptAtRest(payload: Buffer): Promise<Buffer> {
  if (!isAtRestPayload(payload)) {
    throw new Error('Offline package is missing the expected at-rest header.')
  }

  const version = payload[OFFLINE_AT_REST_MAGIC.length]
  if (version !== OFFLINE_AT_REST_VERSION) {
    throw new Error(`Unsupported offline package version ${version}.`)
  }

  const nonceStart = OFFLINE_AT_REST_MAGIC.length + 1
  const nonce = payload.subarray(nonceStart, nonceStart + NONCE_LENGTH)
  const tag = payload.subarray(payload.length - AUTH_TAG_LENGTH)
  const ciphertext = payload.subarray(nonceStart + NONCE_LENGTH, payload.length - AUTH_TAG_LENGTH)

  const key = await getOrCreatePackageKey()
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
