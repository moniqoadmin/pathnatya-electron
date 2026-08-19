import { execFile } from 'child_process'
import { app, screen } from 'electron'
import os from 'os'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type MachineLocation = {
  timezone: string
  locale: string
  countryCode: string
}

export type PcSpecs = {
  platform: string
  arch: string
  osRelease: string
  osVersion: string
  ramGb: number
  ramBytes: number
  cpuModel: string
  cpuCores: number
  hostname: string
  screenWidth: number
  screenHeight: number
  appVersion: string
}

export type MachineProfile = {
  location: MachineLocation
  pcSpecs: PcSpecs
}

export function ramBytesToGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0
  }

  return Math.round((bytes / 1024 ** 3) * 10) / 10
}

export function buildLocation(input: {
  timezone?: string
  locale?: string
  countryCode?: string
}): MachineLocation {
  return {
    timezone: input.timezone?.trim() || '',
    locale: input.locale?.trim() || '',
    countryCode: input.countryCode?.trim().toUpperCase() || ''
  }
}

export function buildPcSpecs(input: {
  platform?: string
  arch?: string
  osRelease?: string
  osVersion?: string
  ramBytes?: number
  cpuModel?: string
  cpuCores?: number
  hostname?: string
  screenWidth?: number
  screenHeight?: number
  appVersion?: string
}): PcSpecs {
  const ramBytes = Number.isFinite(input.ramBytes) ? Number(input.ramBytes) : 0
  const cpuCores = Number.isFinite(input.cpuCores) ? Math.max(0, Math.floor(Number(input.cpuCores))) : 0

  return {
    platform: input.platform?.trim() || '',
    arch: input.arch?.trim() || '',
    osRelease: input.osRelease?.trim() || '',
    osVersion: input.osVersion?.trim() || '',
    ramBytes,
    ramGb: ramBytesToGb(ramBytes),
    cpuModel: input.cpuModel?.trim() || '',
    cpuCores,
    hostname: input.hostname?.trim() || '',
    screenWidth: Number.isFinite(input.screenWidth) ? Math.max(0, Math.round(Number(input.screenWidth))) : 0,
    screenHeight: Number.isFinite(input.screenHeight) ? Math.max(0, Math.round(Number(input.screenHeight))) : 0,
    appVersion: input.appVersion?.trim() || ''
  }
}

function readOsVersionFallback(): string {
  try {
    return os.version()
  } catch {
    return os.release()
  }
}

async function readOsVersion(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sw_vers', [], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      })
      const name = stdout.match(/ProductName:\s*(.+)/i)?.[1]?.trim()
      const version = stdout.match(/ProductVersion:\s*(.+)/i)?.[1]?.trim()
      if (name && version) {
        return `${name} ${version}`
      }
    } catch {
      // Fall through to Node's kernel string.
    }
  }

  return readOsVersionFallback()
}

function readPrimaryScreenSize(): { width: number; height: number } {
  try {
    const { width, height } = screen.getPrimaryDisplay().size
    return { width, height }
  } catch {
    return { width: 0, height: 0 }
  }
}

export async function getMachineProfile(): Promise<MachineProfile> {
  const cpus = os.cpus()
  const screenSize = readPrimaryScreenSize()
  const osVersion = await readOsVersion()

  return {
    location: buildLocation({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: app.getLocale(),
      countryCode: app.getLocaleCountryCode()
    }),
    pcSpecs: buildPcSpecs({
      platform: process.platform,
      arch: os.arch(),
      osRelease: os.release(),
      osVersion,
      ramBytes: os.totalmem(),
      cpuModel: cpus[0]?.model,
      cpuCores: cpus.length,
      hostname: os.hostname(),
      screenWidth: screenSize.width,
      screenHeight: screenSize.height,
      appVersion: app.getVersion()
    })
  }
}
