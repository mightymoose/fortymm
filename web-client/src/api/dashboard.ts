import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type DashboardResponse = components['schemas']['DashboardResponse']
export type DashboardAttentionItem =
  components['schemas']['DashboardAttentionItem']
export type DashboardRecentResult =
  components['schemas']['DashboardRecentResult']
export type DashboardRating = components['schemas']['DashboardRating']
export type DashboardRatingState =
  components['schemas']['DashboardRatingState']
export type DashboardStreak = components['schemas']['DashboardStreak']
export type DashboardTournament = components['schemas']['DashboardTournament']
export type DashboardTournamentEvent =
  components['schemas']['DashboardTournamentEvent']
export type DashboardTournamentMatch =
  components['schemas']['DashboardTournamentMatch']
export type DashboardTournamentFixtureRow =
  components['schemas']['DashboardTournamentFixtureRow']
export type DashboardTournamentGame =
  components['schemas']['DashboardTournamentGame']

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
    // Throw only when there is no cached data to fall back on. An
    // initial-load failure (no cached data) surfaces to the boundary for a
    // retry; a background refetch failure over an already-rendered dashboard
    // must not — see the "`throwOnError` also throws on a background
    // refetch" section of web-client/CLAUDE.md (mirrors #843's fix in
    // `matchQueryOptions`).
    throwOnError: (_error, query) => query.state.data === undefined,
  })
}
