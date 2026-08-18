import { getAppConfiguration, type AppVideoConfiguration } from '../api/app-configurations'

export type { AppVideoConfiguration }

export async function applyAppConfiguration(authToken: string): Promise<AppVideoConfiguration> {
  const config = await getAppConfiguration(authToken)
  await window.pathnatya.setAppConfiguration(config)
  return config
}

/** Drops the in-memory copy only. The encrypted UUID file stays on disk. */

export function clearAppConfiguration(): void {
  void window.pathnatya.clearAppConfiguration()
}
