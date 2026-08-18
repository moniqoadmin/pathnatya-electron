import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNIQUE_APP_CONFIG_NAME } from '../shared/unique-asar-name'

let userDataDir = ''
let bindingMacs = ['AA:BB:CC:DD:EE:FF']

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (payload: Buffer) => payload.toString('utf8')
  }
}))

vi.mock('./device-mac', () => ({
  getOfflineBindingMac: async () => bindingMacs[0] ?? 'macAddress',
  getKnownBindingMacs: async () => bindingMacs,
  getHardwareBindingMacs: async () => [],
  rememberBindingMac: async () => {},
  getSystemMacAddress: () => bindingMacs[0] ?? ''
}))

const { isAtRestPayload } = await import('./hls-offline-crypto')
const {
  clearHlsAppConfiguration,
  getConfiguredVideoFileNames,
  getRequiredHlsSource,
  isAllowedHlsHost,
  loadHlsAppConfiguration,
  saveHlsAppConfiguration,
  setHlsAppConfiguration
} = await import('./hls-config')

const SAMPLE = [
  {
    id: 1,
    videoConfig: {
      DEFAULT_HLS_SOURCE: 'https://cdn.example.com/video-002/playlist.m3u8',
      ALLOWED_HOSTS: ['cdn.example.com']
    },
    videoFiles: ['copy.mp4', { name: 'stolen.bin' }]
  }
]

describe('hls-config', () => {
  beforeEach(async () => {
    bindingMacs = ['AA:BB:CC:DD:EE:FF']
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-config-'))
    clearHlsAppConfiguration()
  })

  afterEach(async () => {
    clearHlsAppConfiguration()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('stores the playlist URL and allowlist from app-configurations', () => {
    setHlsAppConfiguration(SAMPLE)

    expect(getRequiredHlsSource()).toBe('https://cdn.example.com/video-002/playlist.m3u8')
    expect(isAllowedHlsHost('cdn.example.com')).toBe(true)
    expect(isAllowedHlsHost('pathnatya-video-cdn.b-cdn.net')).toBe(false)
    expect(getConfiguredVideoFileNames().has('copy.mp4')).toBe(true)
    expect(getConfiguredVideoFileNames().has('stolen.bin')).toBe(true)
  })

  it('clears hosts and scan names from memory only', () => {
    setHlsAppConfiguration({
      hlsSource: 'https://cdn.example.com/playlist.m3u8',
      allowedHosts: ['cdn.example.com'],
      videoFiles: ['clip.mp4']
    })
    clearHlsAppConfiguration()

    expect(() => getRequiredHlsSource()).toThrow(/not configured/u)
    expect(isAllowedHlsHost('cdn.example.com')).toBe(false)
    expect(getConfiguredVideoFileNames().size).toBe(0)
  })

  it('writes an encrypted UUID file on login save and reads it back', async () => {
    await saveHlsAppConfiguration(SAMPLE)

    const onDisk = await readFile(join(userDataDir, UNIQUE_APP_CONFIG_NAME))
    expect(isAtRestPayload(onDisk)).toBe(true)
    expect(onDisk.toString('utf8')).not.toContain('cdn.example.com')
    expect(onDisk.toString('utf8')).not.toContain('playlist.m3u8')

    clearHlsAppConfiguration()
    expect(() => getRequiredHlsSource()).toThrow(/not configured/u)

    await expect(loadHlsAppConfiguration()).resolves.toMatchObject({
      hlsSource: 'https://cdn.example.com/video-002/playlist.m3u8',
      allowedHosts: ['cdn.example.com'],
      videoFiles: ['copy.mp4', 'stolen.bin']
    })
    expect(getRequiredHlsSource()).toBe('https://cdn.example.com/video-002/playlist.m3u8')
    expect(getConfiguredVideoFileNames().has('stolen.bin')).toBe(true)
  })
})
