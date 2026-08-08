import { CompactEncrypt, compactDecrypt } from 'jose'
import { API_KEY_1 } from './config'

async function getKey(): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(API_KEY_1))
  return new Uint8Array(hash)
}

export async function encryptPayload(data: unknown): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(data)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await getKey())
}

export async function decryptPayload<T = unknown>(token: string): Promise<T> {
  const { plaintext } = await compactDecrypt(token, await getKey())
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
