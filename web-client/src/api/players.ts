import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'

import { api, unwrap } from './client'
import type { components } from './schema'

export type PlayerSummary = components['schemas']['PlayerSummary']
export type PlayerListResponse = components['schemas']['PlayerListResponse']
export type PlayerMatchRow = components['schemas']['PlayerMatchRow']
export type PlayerMatchListResponse =
  components['schemas']['PlayerMatchListResponse']

export interface PlayerListParams {
  q?: string
  page: number
  page_size: number
}

export interface PlayerMatchListParams {
  page: number
  page_size: number
}

/** TanStack Query cache keys — the whole params bag is included so two
 * filters keep separate slots and a refetch on the live filter doesn't blow
 * the others away. */
export function playerListQueryKey(params: PlayerListParams) {
  return ['players', 'list', params] as const
}

export function playerQueryKey(playerId: string) {
  return ['players', 'detail', playerId] as const
}

export function publicPlayerQueryKey(username: string) {
  return ['players', 'public', username] as const
}

export function playerMatchesQueryKey(
  playerId: string,
  params: PlayerMatchListParams,
) {
  return ['players', 'matches', playerId, params] as const
}

/**
 * Paginated /v1/players list backing the `/players` page. Gated on session
 * success so a first-visit direct-load doesn't race the session cookie and
 * 401 into the error boundary (same pattern as `useMatchList`).
 *
 * `placeholderData: keepPreviousData` keeps the current rows on screen while
 * the next page or filter resolves — no flash to empty.
 */
export function usePlayerList(
  params: PlayerListParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: playerListQueryKey(params),
    queryFn: async (): Promise<PlayerListResponse> =>
      unwrap(
        'load players',
        await api.GET('/v1/players', {
          params: {
            query: {
              q: params.q,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      ),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    // Fail-fast to the surrounding error boundary's "Try again" affordance
    // rather than silently retrying behind the skeleton.
    retry: false,
    throwOnError: true,
  })
}

/** Authed profile-page hero. Cache key matches `playerQueryKey(id)` so the
 * cache primed by the list page can serve this view instantly. */
export function playerByIdQueryOptions(playerId: string) {
  return queryOptions({
    queryKey: playerQueryKey(playerId),
    queryFn: async (): Promise<PlayerSummary> =>
      unwrap(
        'load player',
        await api.GET('/v1/players/{player_id}', {
          params: { path: { player_id: playerId } },
        }),
      ),
    retry: false,
    throwOnError: true,
  })
}

export function usePlayerById(
  playerId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({ ...playerByIdQueryOptions(playerId), ...options })
}

/** Public profile-page hero — same shape as the authed view, just keyed by
 * username and unauthenticated. */
export function publicPlayerByUsernameQueryOptions(username: string) {
  return queryOptions({
    queryKey: publicPlayerQueryKey(username),
    queryFn: async (): Promise<PlayerSummary> =>
      unwrap(
        'load public player',
        await api.GET('/v1/p/players/{username}', {
          params: { path: { username } },
        }),
      ),
    retry: false,
    throwOnError: true,
  })
}

export function usePublicPlayerByUsername(username: string) {
  return useQuery(publicPlayerByUsernameQueryOptions(username))
}

/** Per-player paginated match list — pre-shaped from the player's
 * perspective so the FE doesn't have to flip set scores.
 *
 * Intentionally NOT `throwOnError`: the profile page renders an inline
 * "Couldn't load matches · Try again" affordance for transient failures
 * via the hook's `isError` + `refetch`, so a match-fetch hiccup doesn't
 * blank the whole profile page through the route-level error boundary. */
export function usePlayerMatches(
  playerId: string,
  params: PlayerMatchListParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: playerMatchesQueryKey(playerId, params),
    queryFn: async (): Promise<PlayerMatchListResponse> =>
      unwrap(
        'load player matches',
        await api.GET('/v1/players/{player_id}/matches', {
          params: {
            path: { player_id: playerId },
            query: { page: params.page, page_size: params.page_size },
          },
        }),
      ),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    retry: false,
  })
}
