import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { UNIQUE_APP_CONFIG_NAME } from '../shared/unique-asar-name'
import {
  parseAppConfigurationsPayload,
  type AppVideoConfiguration
} from '../shared/app-configuration'
import { decryptAtRest, encryptAtRest, isAtRestPayload } from './hls-offline-crypto'

let configuration: AppVideoConfiguration | null = null
const allowedHosts = new Set<string>()
const videoFileNames = new Set<string>()

function configFilePath(): string {
  return join(app.getPath('userData'), UNIQUE_APP_CONFIG_NAME)
}

function rebuildLookups(next: AppVideoConfiguration | null): void {
  allowedHosts.clear()
  videoFileNames.clear()

  if (!next) {
    return
  }

  for (const host of next.allowedHosts) {
    allowedHosts.add(host.toLowerCase())
  }

  for (const name of next.videoFiles) {
    videoFileNames.add(name.toLowerCase())
  }
}

function applyInMemory(parsed: AppVideoConfiguration): AppVideoConfiguration {
  configuration = parsed
  rebuildLookups(parsed)
  return parsed
}

/** Memory only — tests and post-decrypt hydration. Does not touch disk. */
export function setHlsAppConfiguration(data: unknown): AppVideoConfiguration {
  return applyInMemory(parseAppConfigurationsPayload(data))
}

/**
 * Login path: replace memory and overwrite the encrypted UUID file.
 * The filename is not descriptive; bytes are at-rest sealed to this machine.
 */
export async function saveHlsAppConfiguration(data: unknown): Promise<AppVideoConfiguration> {
  const parsed = setHlsAppConfiguration(data)
  const plaintext = Buffer.from(JSON.stringify(parsed), 'utf8')
  const sealed = await encryptAtRest(plaintext)
  await fs.writeFile(configFilePath(), sealed)
  return parsed
}

/**
 * Source of truth for playback and the drive scan. Decrypts the UUID file
 * into memory; if the file is missing, keeps whatever is already loaded.
 */
export async function loadHlsAppConfiguration(): Promise<AppVideoConfiguration | null> {
  try {
    const sealed = await fs.readFile(configFilePath())
    if (!isAtRestPayload(sealed)) {
      return getHlsAppConfiguration()
    }

    const plaintext = await decryptAtRest(sealed)
    return setHlsAppConfiguration(JSON.parse(plaintext.toString('utf8')))
  } catch {
    return getHlsAppConfiguration()
  }
}

/** Clears in-memory lookups only. The encrypted file stays for the next session. */
export function clearHlsAppConfiguration(): void {
  configuration = null
  rebuildLookups(null)
}

export function getHlsAppConfiguration(): AppVideoConfiguration | null {
  return configuration
    ? {
        hlsSource: configuration.hlsSource,
        allowedHosts: [...configuration.allowedHosts],
        videoFiles: [...configuration.videoFiles]
      }
    : null
}

export function getRequiredHlsSource(): string {
  const source = configuration?.hlsSource?.trim()
  if (!source) {
    throw new Error('1843 : Video source is not configured. Please log in again.')
  }

  return source
}

export function isAllowedHlsHost(hostname: string): boolean {
  return allowedHosts.has(hostname.toLowerCase())
}

export function hasHlsAppConfiguration(): boolean {
  return configuration !== null
}

/** Lowercased basenames from `videoFiles` for the drive scanner. */
export function getConfiguredVideoFileNames(): Set<string> {
  return videoFileNames
}
