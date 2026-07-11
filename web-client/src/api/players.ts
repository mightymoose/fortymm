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

/**
 * The profile bundle's cache key — **player + league** (ADR-0915).
 *
 * The league is part of the key on purpose: the rating half of the profile (the
 * hero, the rating panel, the confidence card, the Leagues card's highlight, and
 * later the chart) is scoped to one ladder, so switching league re-keys the
 * query and the whole bundle refetches in **one** request. A narrower per-card
 * call would be four.
 *
 * `leagueId` is `undefined` for the **default league**, which is what the URL
 * carries no `?league=` for — so the default key stays exactly what it was
 * before leagues existed, and every default-league caller (the route loader, the
 * full-history route) keeps hitting the same cache entry.
 */
export function playerQueryKey(playerId: string, leagueId?: string) {
  return ['players', 'detail', playerId, leagueId ?? null] as const
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

/** Authed profile-page bundle — hero summary + the six most recent matches +
 * the all-inclusive `match_total`, in one request. The profile is an overview
 * (ADR-0915); the full paginated history is its own route, backed by
 * `usePlayerMatches` below. The bundle's six-row window is NOT a page of that
 * list (its `page_size` is 6), so it must not be used to seed the
 * 25-per-page matches cache.
 *
 * `leagueId` names the ladder the bundle's **rating half** is about — the hero's
 * rating, rank, peak and Δ, the form, and the confidence card. Omit it and the
 * API answers with the **default league**, which is what the profile's URL means
 * when it carries no `?league=` (`CONTEXT.md` § *Default league*).
 *
 * Two things it deliberately does not scope: `career`, which is a fact about the
 * *person* and counts every league they play in, and `leagues`, which lists all
 * of them whichever one was asked for (ADR-0915). Both come back identical for
 * the same player in either league — which is exactly why the switcher can
 * re-key this whole query without the Career card flickering into a different
 * number.
 *
 * Pass only a league id the API will accept: it is a `uuid.UUID` on the wire, so
 * FastAPI 422s on a malformed one and 404s on an unknown one. The profile route's
 * search schema catches a mangled `?league=` before it ever gets here.
 */
export function playerByIdQueryOptions(playerId: string, leagueId?: string) {
  return queryOptions({
    queryKey: playerQueryKey(playerId, leagueId),
    queryFn: async (): Promise<PlayerDetail> =>
      unwrap(
        'load player',
        await api.GET('/v1/players/{player_id}', {
          params: {
            path: { player_id: playerId },
            query: { league_id: leagueId },
          },
        }),
      ),
    retry: false,
    throwOnError: true,
  })
}

export function usePlayerById(
  playerId: string,
  options: { enabled?: boolean; leagueId?: string } = {},
) {
  const { leagueId, ...queryOverrides } = options
  return useQuery({
    ...playerByIdQueryOptions(playerId, leagueId),
    ...queryOverrides,
  })
}

/** Per-player paginated match list — pre-shaped from the player's
 * perspective so the FE doesn't have to flip game scores. Backs the full
 * match-history route (`/players/$userId/matches`), 25 rows to a page.
 *
 * The list is deliberately all-inclusive (ADR-0008): every match the player
 * is a side of, any status, rated or not — including the player-less "No
 * opponent" solo sentinel. Don't narrow it.
 *
 * `placeholderData: keepPreviousData` keeps the current page on screen while
 * the next one resolves — no flash to empty between pages.
 *
 * Intentionally NOT `throwOnError`: the page renders an inline
 * "Couldn't load matches · Try again" affordance for transient failures
 * via the hook's `isError` + `refetch`, so a match-fetch hiccup doesn't
 * blank the whole page through the route-level error boundary. */
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
