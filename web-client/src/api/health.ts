import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { components } from './schema'

export type HealthResponse = components['schemas']['HealthResponse']
export type ComponentHealth = components['schemas']['ComponentHealth']

export const HEALTH_QUERY_KEY = ['health'] as const

export function useHealth() {
  return useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: async (): Promise<HealthResponse> => {
      const { data, error } = await api.GET('/v1/health')
      if (error || !data) {
        throw new Error('Failed to load health status')
      }
      return data
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
    retry: false,
  })
}
