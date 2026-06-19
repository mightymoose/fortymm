import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'

import { api, unwrap } from './client'
import type { components } from './schema'

export type PlayerSummary = components['schemas']['PlayerSummary']
export type PlayerDetail = components['schemas']['PlayerDetail']
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

export function playerMatchesQueryKey(
  playerId: string,
  params: PlayerMatchListParams,
) {
  return ['players', 'matches', playerId, params] as const
}

/** Query options for the paginated /v1/players list. Shared by `usePlayerList`
 * and any caller that needs to prefetch the same query — the list route's
 * loader warms this on hover/touch preload so a click renders instantly. */
export function playerListQueryOptions(params: PlayerListParams) {
  return queryOptions({
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
    // Fail-fast to the surrounding error boundary's "Try again" affordance
    // rather than silently retrying behind the skeleton.
    retry: false,
    throwOnError: true,
  })
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
    ...playerListQueryOptions(params),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
  })
}

/** Authed profile-page bundle — hero summary + first page of matches in one
 * request. The FE seeds page 1 of the matches-query cache from
 * `response.matches` via TanStack Query's `initialData` so the profile
 * page paints in a single round trip. */
export function playerByIdQueryOptions(playerId: string) {
  return queryOptions({
    queryKey: playerQueryKey(playerId),
    queryFn: async (): Promise<PlayerDetail> =>
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

/** Per-player paginated match list — pre-shaped from the player's
 * perspective so the FE doesn't have to flip set scores. Backs page 2+ of
 * the authed `/players/$userId` profile page, which already has the id by
 * the time it calls this.
 *
 * Intentionally NOT `throwOnError`: the profile page renders an inline
 * "Couldn't load matches · Try again" affordance for transient failures
 * via the hook's `isError` + `refetch`, so a match-fetch hiccup doesn't
 * blank the whole profile page through the route-level error boundary. */
export function usePlayerMatches(
  playerId: string,
  params: PlayerMatchListParams,
  options: {
    enabled?: boolean
    /** Hydrate the cache with a previously-fetched page (e.g. the
     * first-page matches embedded in the `PlayerDetail` profile
     * response). Caller is responsible for only passing this for the
     * matching page+page_size — the cache key includes them. When
     * provided, the query skips the initial fetch and renders straight
     * from this value. */
    initialData?: PlayerMatchListResponse
  } = {},
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
    initialData: options.initialData,
    // Stamp the seeded data with "just fetched" — the matches were embedded
    // in the profile response in this same render cycle, so they're as
    // fresh as a real fetch would be. Without this, TanStack would use
    // `initialDataUpdatedAt: 0` (epoch) and the data would always be
    // considered stale, triggering a background refetch on mount even
    // within the QueryClient's 30s default `staleTime` (see main.tsx).
    // Function form so the impurity (`Date.now()`) is deferred out of the
    // hook's render — TanStack Query invokes it lazily.
    initialDataUpdatedAt: options.initialData ? () => Date.now() : undefined,
    retry: false,
  })
}
