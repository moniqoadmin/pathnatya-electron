import { BUILD_MARKER_A, BUILD_MARKER_P } from './build-marker'
import { CHANNEL_TOKEN_B, CHANNEL_TOKEN_Q } from './channel-token'
import { DEVICE_NONCE_D, DEVICE_NONCE_S } from './device-nonce'
import { HOST_CIPHER_H } from './host-cipher'
import { ROUTE_CIPHER_R } from './route-cipher'
import { SESSION_SALT_C, SESSION_SALT_R } from './session-salt'

function assemble(parts: string[], order: readonly number[]): string {
  return order.map((index) => parts[index] ?? '').join('')
}

function reveal(cipher: number[], key: string): string {
  const chars: string[] = []
  let mix = 0x5a
  for (let i = 0; i < cipher.length; i++) {
    const k = key.charCodeAt(i % key.length)
    mix = (mix * 33 + k + i) & 0xff
    chars.push(String.fromCharCode((cipher[i] ?? 0) ^ mix ^ k))
  }
  return chars.join('')
}

// Fragments live in separate modules; order here is intentional, not source order.
export const APP_KEY = assemble(
  [DEVICE_NONCE_D, CHANNEL_TOKEN_B, BUILD_MARKER_A, SESSION_SALT_C],
  [2, 1, 3, 0]
)

export const API_KEY_1 = assemble(
  [DEVICE_NONCE_S, CHANNEL_TOKEN_Q, BUILD_MARKER_P, SESSION_SALT_R],
  [2, 1, 3, 0]
)

export const API_BASE = reveal([...HOST_CIPHER_H, ...ROUTE_CIPHER_R], APP_KEY)
