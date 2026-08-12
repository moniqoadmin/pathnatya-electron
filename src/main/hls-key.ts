export const AES_128_KEY_LENGTH = 16

let sessionKey: Buffer | null = null

/**
 * Accepts hex, base64/base64url, or a 16-character raw string. The raw form is
 * decoded as latin1 because the key is 16 arbitrary bytes: when it is carried in
 * an env var as a binary string, each byte arrives as one code point, and utf8
 * would re-encode the bytes above 0x7f into two.
 */
function decodeKeyToken(token: string): Buffer {
  if (!token) {
    throw new Error('469 : Video key token is empty.')
  }

  const trimmed = token.trim()
  const hex = trimmed.replace(/^0x/iu, '')

  if (/^[0-9a-f]{32}$/iu.test(hex)) {
    return Buffer.from(hex, 'hex')
  }

  const base64 = Buffer.from(trimmed.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64')
  if (base64.length === AES_128_KEY_LENGTH) {
    return base64
  }

  // A raw key can contain whitespace bytes, so the untrimmed value has to be tried too.
  for (const candidate of new Set([token, trimmed])) {
    const utf8 = Buffer.from(candidate, 'utf8')
    if (utf8.length === AES_128_KEY_LENGTH) {
      return utf8
    }

    if (candidate.length === AES_128_KEY_LENGTH && !/[^\u0000-\u00ff]/u.test(candidate)) {
      return Buffer.from(candidate, 'latin1')
    }
  }

  throw new Error(
    `7524 : Video key token does not decode to ${AES_128_KEY_LENGTH} bytes for AES-128 ` +
      `(got ${token.length} characters). Store the key as hex or base64.`
  )
}

/** Installs the AES-128 key issued by the login-token API for this session. */
export function setHlsKey(token: string): void {
  const key = decodeKeyToken(token)
  clearHlsKey()
  sessionKey = key
}

export function getHlsKey(): Buffer {
  if (!sessionKey) {
    throw new Error('3167 : Video key is not available for this session. Please log in again.')
  }

  return sessionKey
}

export function clearHlsKey(): void {
  sessionKey?.fill(0)
  sessionKey = null
}
