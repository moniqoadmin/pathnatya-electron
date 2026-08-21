import { getAppConfiguration, type AppVideoConfiguration } from '../api/app-configurations'

export type { AppVideoConfiguration }

export async function applyAppConfiguration(authToken: string): Promise<AppVideoConfiguration> {
  const config = await getAppConfiguration(authToken)
  await window.pathnatya.setAppConfiguration(config)
  return config
}

/** Scene markers from the encrypted on-disk app configuration. Empty when missing. */
export async function getStoredVideoScenes(): Promise<
  Array<{ scene: number; label: string; time: string }>
> {
  try {
    return (await window.pathnatya.getVideoScenes()) ?? []
  } catch {
    return []
  }
}

/** Drops the in-memory copy only. The encrypted UUID file stays on disk. */

export function clearAppConfiguration(): void {
  void window.pathnatya.clearAppConfiguration()
}
