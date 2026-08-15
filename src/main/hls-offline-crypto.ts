import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { getOfflineBindingMac } from './device-mac'

/** Magic: PathNatya Offline Format */
export const OFFLINE_AT_REST_MAGIC = Buffer.from('PNOF')
/** v2: package key is bound to the machine MAC (Windows + macOS). */
export const OFFLINE_AT_REST_VERSION = 2

const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const HEADER_LENGTH = OFFLINE_AT_REST_MAGIC.length + 1 + NONCE_LENGTH
const KEY_FILE = 'hls-offline.atrest'

function offlineCryptoLog(message: string, detail?: Record<string, unknown>): void {
  if (detail) {
    console.log(`[hls-offline:crypto] ${message}`, detail)
  } else {
    console.log(`[hls-offline:crypto] ${message}`)
  }
}

/**
 * Layout on disk:
 *   MAGIC(4) | VERSION(1) | NONCE(12) | CIPHERTEXT | AUTH_TAG(16)
 *
 * The MAC address is not written into the sealed blob. It is re-read from the
 * OS at encrypt/decrypt time and mixed into the AES key so the package only
 * opens on the same machine.
 */
function keyFilePath(): string {
  return join(app.getPath('userData'), KEY_FILE)
}

/** Mix the live NIC MAC into the raw package key (never persists the MAC itself). */
function bindKeyToMac(rawKey: Buffer, mac: string): Buffer {
  return createHash('sha256')
    .update(rawKey)
    .update('|mac|')
    .update(mac.toUpperCase())
    .digest()
}

function fallbackRawKey(): Buffer {
  return createHash('sha256')
    .update('pathnatya:hls-offline:at-rest:v2')
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

async function getOrCreateRawPackageKey(): Promise<Buffer> {
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
    offlineCryptoLog('created at-rest package key', {
      path,
      safeStorage: safeStorage.isEncryptionAvailable()
    })
    return key
  } catch {
    // Cannot persist (e.g. tests without a writable userData) — deterministic fallback.
    offlineCryptoLog('using fallback at-rest key (could not persist)')
    return fallbackRawKey()
  }
}

async function getPackageKey(): Promise<{ key: Buffer; mac: string }> {
  const rawKey = await getOrCreateRawPackageKey()
  const mac = getOfflineBindingMac()
  return { key: bindKeyToMac(rawKey, mac), mac }
}

export function isAtRestPayload(payload: Buffer): boolean {
  return (
    payload.length >= HEADER_LENGTH + AUTH_TAG_LENGTH &&
    payload.subarray(0, OFFLINE_AT_REST_MAGIC.length).equals(OFFLINE_AT_REST_MAGIC)
  )
}

/** Encrypt plaintext and prepend the custom at-rest header. */
export async function encryptAtRest(plaintext: Buffer): Promise<Buffer> {
  const { key, mac } = await getPackageKey()
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  const sealed = Buffer.concat([
    OFFLINE_AT_REST_MAGIC,
    Buffer.from([OFFLINE_AT_REST_VERSION]),
    nonce,
    ciphertext,
    tag
  ])

  offlineCryptoLog('encrypt + header', {
    plaintextBytes: plaintext.length,
    sealedBytes: sealed.length,
    magic: OFFLINE_AT_REST_MAGIC.toString('utf8'),
    version: OFFLINE_AT_REST_VERSION,
    macBound: Boolean(mac && mac !== 'macAddress')
  })

  return sealed
}

/**
 * Strip the custom header and decrypt in memory.
 * Throws if the header is missing/invalid or authentication fails.
 * Plaintext is never written back to disk — callers keep it in RAM only.
 */
export async function decryptAtRest(payload: Buffer): Promise<Buffer> {
  if (!isAtRestPayload(payload)) {
    offlineCryptoLog('decrypt failed: missing at-rest header', { sealedBytes: payload.length })
    throw new Error('891 : Offline package is missing the expected at-rest header.')
  }

  const version = payload[OFFLINE_AT_REST_MAGIC.length]
  if (version !== OFFLINE_AT_REST_VERSION) {
    offlineCryptoLog('decrypt failed: unsupported version', { version })
    throw new Error(`4386 : Unsupported offline package version ${version}.`)
  }

  const nonceStart = OFFLINE_AT_REST_MAGIC.length + 1
  const nonce = payload.subarray(nonceStart, nonceStart + NONCE_LENGTH)
  const tag = payload.subarray(payload.length - AUTH_TAG_LENGTH)
  const ciphertext = payload.subarray(nonceStart + NONCE_LENGTH, payload.length - AUTH_TAG_LENGTH)

  const { key, mac } = await getPackageKey()
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    offlineCryptoLog('decrypt + strip header', {
      sealedBytes: payload.length,
      plaintextBytes: plaintext.length,
      magic: OFFLINE_AT_REST_MAGIC.toString('utf8'),
      version,
      macBound: Boolean(mac && mac !== 'macAddress')
    })
    return plaintext
  } catch {
    // GCM auth failure: wrong machine MAC mixed into the key, or tampered ciphertext.
    offlineCryptoLog('decrypt failed: auth tag (wrong device MAC or tampered package)', {
      sealedBytes: payload.length,
      macBound: Boolean(mac && mac !== 'macAddress')
    })
    throw new Error('2194 : Offline video is not valid on this device.')
  }
}
