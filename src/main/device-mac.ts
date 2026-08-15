import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { app, safeStorage } from 'electron'

const execFileAsync = promisify(execFile)

const ZERO_MAC = '00:00:00:00:00:00'
const VIRTUAL_IFACE_RE =
  /^(lo|loopback|awdl|llw|utun|bridge|vmenet|vmnet|vboxnet|docker|veth|br-|ap|p2p|bluetooth)/i
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/iu

/** Sealed list of MACs this install has seen, so offline binding survives a downed NIC. */
const BINDING_FILE = 'device-binding.dat'
const MAX_REMEMBERED_MACS = 8
const MAX_HARDWARE_MACS = 16
/** Stand-in used when this install has never observed a real NIC MAC. */
export const FALLBACK_BINDING_MAC = 'macAddress'

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4 || String(family) === '4'
}

function normalizeMac(mac: string): string {
  return mac.trim().replace(/-/gu, ':').toUpperCase()
}

function isRealMac(mac: string | undefined): boolean {
  return Boolean(mac && MAC_RE.test(mac.trim()) && normalizeMac(mac) !== ZERO_MAC)
}

function isUsableMac(mac: string | undefined): boolean {
  return Boolean(mac && mac !== ZERO_MAC)
}

/** Prefer real Wi‑Fi/Ethernet adapters; deprioritize VPN/virtual (esp. important on macOS). */
function interfaceScore(name: string): number {
  if (VIRTUAL_IFACE_RE.test(name)) {
    return 0
  }

  if (/^en\d+$/i.test(name)) {
    return 100
  }

  if (/^eth\d+$/i.test(name) || /^wlan\d+$/i.test(name)) {
    return 95
  }

  if (/wi-?fi|wireless|ethernet|local area connection/i.test(name)) {
    return 90
  }

  return 40
}

/**
 * Primary NIC MAC for Windows and macOS.
 * Used to bind offline video at-rest encryption to this machine.
 * Returns "" when no usable adapter is found.
 */
export function getSystemMacAddress(): string {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ mac: string; score: number }> = []

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) {
      continue
    }

    const baseScore = interfaceScore(name)
    if (baseScore === 0) {
      continue
    }

    for (const net of nets) {
      if (net.internal || !isUsableMac(net.mac)) {
        continue
      }

      const score = baseScore + (isIpv4Family(net.family) ? 10 : 0)
      candidates.push({ mac: net.mac.toUpperCase(), score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.mac ?? ''
}

function bindingFilePath(): string {
  return join(app.getPath('userData'), BINDING_FILE)
}

function seal(plaintext: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext)
  }

  return Buffer.from(plaintext, 'utf8')
}

function unseal(payload: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(payload)
  }

  return payload.toString('utf8')
}

let rememberedMacs: string[] | null = null

async function readRememberedMacs(): Promise<string[]> {
  if (rememberedMacs) {
    return rememberedMacs
  }

  try {
    const parsed = JSON.parse(unseal(await fs.readFile(bindingFilePath()))) as {
      version?: number
      macs?: unknown
    }

    rememberedMacs =
      parsed?.version === 1 && Array.isArray(parsed.macs)
        ? parsed.macs
            .filter((mac): mac is string => isRealMac(typeof mac === 'string' ? mac : undefined))
            .map(normalizeMac)
            .slice(0, MAX_REMEMBERED_MACS)
        : []
  } catch {
    rememberedMacs = []
  }

  return rememberedMacs
}

/** Record a MAC that sealed or opened this device's offline data, most recent first. */
export async function rememberBindingMac(mac: string): Promise<void> {
  if (!isRealMac(mac)) {
    return
  }

  const normalized = normalizeMac(mac)
  const known = await readRememberedMacs()
  if (known[0] === normalized) {
    return
  }

  const next = [normalized, ...known.filter((value) => value !== normalized)].slice(
    0,
    MAX_REMEMBERED_MACS
  )
  rememberedMacs = next

  try {
    await fs.writeFile(bindingFilePath(), seal(JSON.stringify({ version: 1, macs: next })))
  } catch {
    // Best-effort — the in-memory list still covers the rest of this run.
  }
}

/**
 * MACs that may have sealed this device's offline package, most likely first.
 *
 * `os.networkInterfaces()` only reports adapters that currently hold an address, so a
 * laptop with Wi-Fi switched off looks like it has no MAC at all. Sealing a package
 * under the live MAC and later trying to open it under the fallback would make an
 * already-downloaded video unreadable offline, so every MAC this install has seen
 * stays a candidate.
 */
export async function getKnownBindingMacs(): Promise<string[]> {
  const live = getSystemMacAddress()
  if (live) {
    await rememberBindingMac(live)
  }

  const remembered = await readRememberedMacs()
  return [...new Set([...(live ? [live] : []), ...remembered, FALLBACK_BINDING_MAC])]
}

/** MAC used to seal new offline data: the live adapter, else the last one seen here. */
export async function getOfflineBindingMac(): Promise<string> {
  const [primary] = await getKnownBindingMacs()
  return primary ?? FALLBACK_BINDING_MAC
}

/** Windows `getmac` lists adapters even while disconnected, unlike os.networkInterfaces(). */
function parseWindowsMacs(stdout: string): string[] {
  const macs: string[] = []

  for (const line of stdout.split(/\r?\n/u)) {
    const columns = line.split('","').map((value) => value.replace(/"/gu, '').trim())
    if (columns.length < 3 || !isRealMac(columns[2])) {
      continue
    }

    macs.push(normalizeMac(columns[2]))
  }

  return macs
}

/** macOS `ifconfig -a` reports `ether` for every port, up or not. */
function parseDarwinMacs(stdout: string): string[] {
  const macs: string[] = []

  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*ether\s+([0-9a-f:]{17})/iu)
    if (match && isRealMac(match[1])) {
      macs.push(normalizeMac(match[1]))
    }
  }

  return macs
}

let hardwareMacs: Promise<string[]> | null = null

/**
 * Every adapter MAC on this machine, including adapters that hold no address right now.
 * Costs a subprocess, so callers reach for it only after the cheap candidates fail.
 */
export async function getHardwareBindingMacs(): Promise<string[]> {
  if (!hardwareMacs) {
    hardwareMacs = (async () => {
      const options = { encoding: 'utf8' as const, timeout: 5000, windowsHide: true }

      try {
        if (process.platform === 'win32') {
          const { stdout } = await execFileAsync('getmac', ['/v', '/fo', 'csv', '/nh'], options)
          return [...new Set(parseWindowsMacs(stdout))].slice(0, MAX_HARDWARE_MACS)
        }

        if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('ifconfig', ['-a'], options)
          return [...new Set(parseDarwinMacs(stdout))].slice(0, MAX_HARDWARE_MACS)
        }
      } catch {
        // No adapter list available — the remembered MACs are all we have.
      }

      return []
    })()
  }

  return hardwareMacs
}

/** Test helper — drop cached MAC state between cases. */
export function __resetDeviceMacCacheForTests(): void {
  rememberedMacs = null
  hardwareMacs = null
}
