import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNIQUE_MANIFEST_NAME } from '../shared/unique-asar-name'

let userDataDir = ''
/** Stands in for the MACs device-mac would offer, most likely first. */
let bindingMacs = ['AA:BB:CC:DD:EE:FF']
/** Adapters the OS can still enumerate once nothing holds an address. */
let hardwareMacs: string[] = []

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
  getHardwareBindingMacs: async () => hardwareMacs,
  rememberBindingMac: async () => {},
  getSystemMacAddress: () => bindingMacs[0] ?? ''
}))

const {
  OFFLINE_AT_REST_MAGIC,
  OFFLINE_AT_REST_VERSION,
  decryptAtRest,
  encryptAtRest,
  isAtRestPayload
} = await import('./hls-offline-crypto')

const {
  assertOfflinePackageIntegrity,
  deleteOfflineVideo,
  hashOfflinePayload,
  readOfflineManifest,
  readOfflineSegment,
  writeOfflineIntegrity,
  writeOfflineManifest,
  writeOfflineSegment
} = await import('./hls-offline')

describe('hls-offline-crypto', () => {
  beforeEach(async () => {
    bindingMacs = ['AA:BB:CC:DD:EE:FF']
    hardwareMacs = []
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-offline-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('round-trips plaintext with a custom header', async () => {
    const plaintext = Buffer.from('segment-bytes-here')
    const sealed = await encryptAtRest(plaintext)

    expect(isAtRestPayload(sealed)).toBe(true)
    expect(sealed.subarray(0, 4).equals(OFFLINE_AT_REST_MAGIC)).toBe(true)
    expect(sealed[4]).toBe(OFFLINE_AT_REST_VERSION)
    expect(sealed.equals(plaintext)).toBe(false)
    expect(sealed.includes(plaintext)).toBe(false)

    await expect(decryptAtRest(sealed)).resolves.toEqual(plaintext)
  })

  it('rejects payloads without the at-rest header', async () => {
    await expect(decryptAtRest(Buffer.from('not-encrypted'))).rejects.toThrow(/at-rest header/u)
  })

  it('rejects tampered ciphertext', async () => {
    const sealed = await encryptAtRest(Buffer.from('video'))
    sealed[sealed.length - 5] ^= 0xff
    await expect(decryptAtRest(sealed)).rejects.toThrow()
  })

  it('fails decrypt when the bound MAC changes', async () => {
    const sealed = await encryptAtRest(Buffer.from('mac-bound-video'))
    bindingMacs = ['11:22:33:44:55:66']
    await expect(decryptAtRest(sealed)).rejects.toThrow(/not valid on this device/u)
  })

  it('decrypts after the sealing adapter goes offline and reports no MAC', async () => {
    const plaintext = Buffer.from('downloaded-while-online')
    const sealed = await encryptAtRest(plaintext)

    // Offline: os.networkInterfaces() reports nothing, so only the remembered MAC is left.
    bindingMacs = ['AA:BB:CC:DD:EE:FF', 'macAddress']
    await expect(decryptAtRest(sealed)).resolves.toEqual(plaintext)
  })

  it('decrypts via an enumerated adapter when nothing was remembered', async () => {
    const plaintext = Buffer.from('sealed-before-upgrade')
    const sealed = await encryptAtRest(plaintext)

    bindingMacs = ['macAddress']
    hardwareMacs = ['AA:BB:CC:DD:EE:FF']
    await expect(decryptAtRest(sealed)).resolves.toEqual(plaintext)
  })
})

describe('hls-offline at-rest storage', () => {
  beforeEach(async () => {
    bindingMacs = ['AA:BB:CC:DD:EE:FF']
    hardwareMacs = []
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-offline-'))
  })

  afterEach(async () => {
    await deleteOfflineVideo()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('stores encrypted segments and decrypts only in memory', async () => {
    const original = Buffer.from([0x00, 0x01, 0x02, 0x47, 0x40])
    await writeOfflineSegment(0, original)

    const onDisk = await readFile(join(userDataDir, 'hls-offline', 'segments', 'segment_000.bin'))
    expect(isAtRestPayload(onDisk)).toBe(true)
    expect(onDisk.equals(original)).toBe(false)

    await expect(readOfflineSegment(0)).resolves.toEqual(original)
  })

  it('stores an encrypted manifest and reads it back decrypted', async () => {
    const manifest = {
      version: 1 as const,
      sourceUrl: 'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8',
      downloadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      totalDurationSeconds: 30,
      segmentCount: 1,
      rewrittenPlaylist: '#EXTM3U\n',
      segments: [{ index: 0, durationSeconds: 30, iv: null, file: 'segment_000.bin' }]
    }

    await writeOfflineManifest(manifest)

    const onDisk = await readFile(join(userDataDir, 'hls-offline', UNIQUE_MANIFEST_NAME))
    // Whole DB is at-rest sealed — no SQLite magic or plaintext on disk.
    expect(isAtRestPayload(onDisk)).toBe(true)
    expect(onDisk.subarray(0, 15).toString('utf8')).not.toBe('SQLite format 3')
    expect(onDisk.toString('utf8')).not.toContain('sourceUrl')
    expect(onDisk.toString('utf8')).not.toContain('SQLite format 3')

    await expect(readOfflineManifest()).resolves.toEqual(manifest)
  })

  it('wipes the offline package when decrypt fails due to MAC mismatch', async () => {
    const original = Buffer.from('mac-bound-segment')
    await writeOfflineSegment(0, original)

    const manifest = {
      version: 1 as const,
      sourceUrl: 'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8',
      downloadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      totalDurationSeconds: 1,
      segmentCount: 1,
      rewrittenPlaylist: '#EXTM3U\n',
      segments: [{ index: 0, durationSeconds: 1, iv: null, file: 'segment_000.bin' }]
    }
    await writeOfflineManifest(manifest)

    const packageDir = join(userDataDir, 'hls-offline')
    await expect(readFile(join(packageDir, UNIQUE_MANIFEST_NAME))).resolves.toBeInstanceOf(Buffer)

    bindingMacs = ['11:22:33:44:55:66']
    await expect(readOfflineSegment(0)).resolves.toBeNull()
    await expect(readFile(join(packageDir, UNIQUE_MANIFEST_NAME))).rejects.toThrow()
    await expect(readFile(join(packageDir, 'segments', 'segment_000.bin'))).rejects.toThrow()
  })

  it('stores segment hashes outside the package and verifies after decrypt', async () => {
    const original = Buffer.from('integrity-segment')
    const digest = await writeOfflineSegment(0, original)
    expect(digest).toBe(hashOfflinePayload(original))

    await writeOfflineIntegrity([digest])

    const integrityOnDisk = await readFile(join(userDataDir, 'hls-offline.integrity'))
    expect(isAtRestPayload(integrityOnDisk)).toBe(true)
    expect(integrityOnDisk.toString('utf8')).not.toContain(digest)

    const manifest = {
      version: 1 as const,
      sourceUrl: 'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8',
      downloadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      totalDurationSeconds: 1,
      segmentCount: 1,
      rewrittenPlaylist: '#EXTM3U\n',
      segments: [{ index: 0, durationSeconds: 1, iv: null, file: 'segment_000.bin' }]
    }
    await writeOfflineManifest(manifest)

    await expect(assertOfflinePackageIntegrity(manifest)).resolves.toBeUndefined()
  })

  it('fails integrity when a decrypted segment does not match its hash', async () => {
    const digest = await writeOfflineSegment(0, Buffer.from('original-bytes'))
    await writeOfflineIntegrity([digest])

    // Overwrite segment with different encrypted payload after hashes were recorded.
    await writeOfflineSegment(0, Buffer.from('tampered-bytes'))

    const manifest = {
      version: 1 as const,
      sourceUrl: 'https://pathnatya-video-cdn.b-cdn.net/video-001/playlist.m3u8',
      downloadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      totalDurationSeconds: 1,
      segmentCount: 1,
      rewrittenPlaylist: '#EXTM3U\n',
      segments: [{ index: 0, durationSeconds: 1, iv: null, file: 'segment_000.bin' }]
    }
    await writeOfflineManifest(manifest)

    await expect(assertOfflinePackageIntegrity(manifest)).rejects.toThrow(/integrity check/u)
  })
})
