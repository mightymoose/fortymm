import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type DashboardResponse = components['schemas']['DashboardResponse']
export type DashboardAttentionItem =
  components['schemas']['DashboardAttentionItem']
export type DashboardRecentResult =
  components['schemas']['DashboardRecentResult']
export type DashboardRating = components['schemas']['DashboardRating']
export type DashboardStreak = components['schemas']['DashboardStreak']

export const DASHBOARD_QUERY_KEY = ['dashboard'] as const

/**
 * The dashboard endpoint requires an established session (it never mints
 * one), so callers in components that mount before the session resolves
 * pass `enabled: session.isSuccess` to avoid a first-visit 401 race.
 * Throws on failure so the surrounding boundary can render a retry.
 */
export function useDashboard(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: async (): Promise<DashboardResponse> =>
      unwrap('load dashboard', await api.GET('/v1/dashboard')),
    enabled: options.enabled ?? true,
    retry: false,
    throwOnError: true,
  })
}
