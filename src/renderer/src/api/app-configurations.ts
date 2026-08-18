import { apiFetch } from './client'
import {
  parseAppConfigurationsPayload,
  type AppVideoConfiguration
} from '../../../shared/app-configuration'

export type { AppVideoConfiguration }

export async function getAppConfiguration(authToken: string): Promise<AppVideoConfiguration> {
  const data = await apiFetch<unknown>('/app-configurations', { authToken })
  return parseAppConfigurationsPayload(data)
}
