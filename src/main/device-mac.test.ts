import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''
let interfaces: Record<string, Array<Record<string, unknown>>> = {}

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (payload: Buffer) => payload.toString('utf8')
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, networkInterfaces: () => interfaces },
    networkInterfaces: () => interfaces
  }
})

let commandOutput: Record<string, string> = {}

vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (): void => {}
  // promisify() honours this symbol, so the module under test still awaits { stdout }.
  Object.defineProperty(execFile, promisify.custom, {
    value: async (file: string) => ({ stdout: commandOutput[file] ?? '' })
  })
  return { execFile }
})

const {
  __resetDeviceMacCacheForTests,
  getHardwareBindingMacs,
  getKnownBindingMacs,
  getSystemMacAddress
} = await import('./device-mac')

const WIFI_UP = {
  'Wi-Fi': [
    { mac: 'a0:e7:0b:2c:93:68', family: 'IPv4', internal: false, address: '192.168.1.5' }
  ],
  'Loopback Pseudo-Interface 1': [
    { mac: '00:00:00:00:00:00', family: 'IPv4', internal: true, address: '127.0.0.1' }
  ]
}

/** Windows drops every disconnected adapter from os.networkInterfaces(). */
const WIFI_OFF = {
  'Loopback Pseudo-Interface 1': [
    { mac: '00:00:00:00:00:00', family: 'IPv4', internal: true, address: '127.0.0.1' }
  ]
}

describe('device-mac binding candidates', () => {
  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-mac-'))
    interfaces = WIFI_UP
    __resetDeviceMacCacheForTests()
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('reports no MAC once the adapter is disconnected', () => {
    interfaces = WIFI_OFF
    expect(getSystemMacAddress()).toBe('')
  })

  it('keeps offering the online MAC after the adapter goes down', async () => {
    await expect(getKnownBindingMacs()).resolves.toContain('A0:E7:0B:2C:93:68')

    interfaces = WIFI_OFF
    __resetDeviceMacCacheForTests()

    await expect(getKnownBindingMacs()).resolves.toContain('A0:E7:0B:2C:93:68')
  })

  it('offers the current adapter before older ones', async () => {
    await getKnownBindingMacs()

    interfaces = {
      Ethernet: [
        { mac: '11:22:33:44:55:66', family: 'IPv4', internal: false, address: '10.0.0.4' }
      ]
    }
    __resetDeviceMacCacheForTests()

    await expect(getKnownBindingMacs()).resolves.toEqual([
      '11:22:33:44:55:66',
      'A0:E7:0B:2C:93:68',
      'macAddress'
    ])
  })

  it('falls back to the placeholder on a machine that never had an adapter', async () => {
    interfaces = WIFI_OFF
    await expect(getKnownBindingMacs()).resolves.toEqual(['macAddress'])
  })
})

describe('device-mac hardware enumeration', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    commandOutput = {}
    __resetDeviceMacCacheForTests()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('reads Windows adapters that hold no address, skipping unusable rows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    commandOutput.getmac = [
      '"Wi-Fi","Intel(R) Wi-Fi 6 AX201 160MHz","A0-E7-0B-2C-93-68","\\Device\\Tcpip_{338E6AE7}"',
      '"Bluetooth Network Connection","Bluetooth Device","A0-E7-0B-2C-93-6C","Media disconnected"',
      '"Ethernet","PANGP Virtual Ethernet Adapter","Disabled","Disconnected"',
      '"OpenVPN Connect DCO Adapter","OpenVPN Data Channel","N/A","Media disconnected"'
    ].join('\r\n')

    await expect(getHardwareBindingMacs()).resolves.toEqual([
      'A0:E7:0B:2C:93:68',
      'A0:E7:0B:2C:93:6C'
    ])
  })

  it('reads macOS ports from ifconfig', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    commandOutput.ifconfig = [
      'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384',
      '\tinet 127.0.0.1 netmask 0xff000000',
      'en0: flags=8863<UP,BROADCAST,SMART,RUNNING> mtu 1500',
      '\tether 3c:22:fb:1a:2b:3c',
      'en1: flags=8822<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500',
      '\tether 82:14:5f:99:00:01'
    ].join('\n')

    await expect(getHardwareBindingMacs()).resolves.toEqual([
      '3C:22:FB:1A:2B:3C',
      '82:14:5F:99:00:01'
    ])
  })

  it('returns nothing when the adapter list cannot be read', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await expect(getHardwareBindingMacs()).resolves.toEqual([])
  })
})
