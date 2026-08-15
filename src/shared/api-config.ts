import { BUILD_MARKER_A, BUILD_MARKER_P } from './build-marker'
import { CHANNEL_TOKEN_B, CHANNEL_TOKEN_Q } from './channel-token'
import { DEVICE_NONCE_D, DEVICE_NONCE_S } from './device-nonce'
import { SESSION_SALT_C, SESSION_SALT_R } from './session-salt'

function assemble(parts: string[], order: readonly number[]): string {
  return order.map((index) => parts[index] ?? '').join('')
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

export const API_BASE = 'https://pathnatya-be-production.up.railway.app/api'
