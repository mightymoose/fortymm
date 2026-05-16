import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type DashboardResponse = components['schemas']['DashboardResponse']
export type DashboardScoreBanner =
  components['schemas']['DashboardScoreBanner']
export type DashboardNextMatch = components['schemas']['DashboardNextMatch']
export type DashboardRecentResult =
  components['schemas']['DashboardRecentResult']

export const DASHBOARD_QUERY_KEY = ['dashboard'] as const

/** Throws on failure so the dashboard route's boundary can render a retry. */
export function useDashboard() {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: async (): Promise<DashboardResponse> =>
      unwrap('load dashboard', await api.GET('/v1/dashboard')),
    retry: false,
    throwOnError: true,
  })
}
