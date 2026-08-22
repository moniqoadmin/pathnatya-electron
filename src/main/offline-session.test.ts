import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (payload: Buffer) => payload.toString('utf8')
  }
}))

vi.mock('./video-tamper-lock', () => ({
  isVideoTampered: vi.fn()
}))

vi.mock('./hls-config', () => ({
  loadHlsAppConfiguration: vi.fn(),
  getHlsAppConfiguration: vi.fn(() => null)
}))

vi.mock('./offline-checkin', () => ({
  isOfflineCheckInRequired: vi.fn()
}))

vi.mock('./trusted-time', () => ({
  getTrustedNowDate: () => new Date('2026-01-01T00:00:00.000Z'),
  isTrustedTtlExpired: () => false,
  isTrustedExpired: () => false,
  loadTrustedTime: vi.fn(),
  setNumberOfRebootFromAccount: vi.fn()
}))

const { isVideoTampered } = await import('./video-tamper-lock')
const { hasOfflineSession, tryOfflineLogin } = await import('./offline-session')

describe('offline-session tamper lock', () => {
  it('refuses offline login after video files were tampered', async () => {
    vi.mocked(isVideoTampered).mockResolvedValue(true)

    await expect(tryOfflineLogin('9876543210', 'secret')).resolves.toEqual({
      ok: false,
      reason: 'tampered'
    })
    await expect(hasOfflineSession('9876543210')).resolves.toBe(false)
  })
})
