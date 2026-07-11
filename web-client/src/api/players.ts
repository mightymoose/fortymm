import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'

import { api, unwrap } from './client'
import type { components, operations } from './schema'

export type PlayerSummary = components['schemas']['PlayerSummary']
export type PlayerDetail = components['schemas']['PlayerDetail']
export type PlayerListResponse = components['schemas']['PlayerListResponse']
export type PlayerMatchRow = components['schemas']['PlayerMatchRow']
export type PlayerMatchListResponse =
  components['schemas']['PlayerMatchListResponse']
export type RatingHistoryWindow = components['schemas']['RatingHistoryWindow']
export type RatingPoint = components['schemas']['RatingPoint']

/** The rating chart's calendar windows (ADR-0915) — read straight off the
 * generated OpenAPI operation rather than retyped, so adding a range on the API
 * lands here as a type error until the tabs handle it. */
export type RatingRange = NonNullable<
  NonNullable<
    operations['get_player_rating_history_v1_players__player_id__rating_history_get']['parameters']['query']
  >['range']
>

/** The three ranges, in the order the tabs show them. The `satisfies` is the
 * guard: drop one and the union above no longer covers it. */
export const RATING_RANGES = ['30d', '90d', '1y'] as const satisfies readonly RatingRange[]

/** The window the API answers with when no `range` is named — so it is also what
 * a URL with **no `?range=`** means, and the value the tabs omit from the URL
 * rather than spelling out (`CONTEXT.md` § *Rating timeline*). */
export const DEFAULT_RATING_RANGE: RatingRange = '90d'

/**
 * How long a rating-history window counts as fresh.
 *
 * Explicit, and load-bearing, rather than left to the `QueryClient`'s default:
 * the chart's first paint is served from data **seeded** out of the profile
 * bundle (see `ratingHistoryQueryOptions`). Under a client with `staleTime: 0`
 * that seed would be stale the instant it landed and `refetchOnMount` would go
 * and fetch the very window it was just handed — costing the extra request the
 * seed exists to avoid. Mirrors `main.tsx`'s 30s app default so a real page
 * behaves the same as a test.
 */
const RATING_HISTORY_STALE_TIME = 30_000

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
 * The profile bundle's cache key — **player + league**, and deliberately NOT the
 * chart's range (ADR-0915).
 *
 * The league is part of the key on purpose: the rating half of the profile (the
 * hero, the rating panel, the confidence card, the Leagues card's highlight, and
 * the chart) is scoped to one ladder, so switching league re-keys the query and
 * the whole bundle refetches in **one** request. A narrower per-card call would
 * be four.
 *
 * The **range is not**, and that is just as deliberate. The bundle *request*
 * carries it (`playerByIdQueryOptions` below sends `?range=`, and the response
 * embeds that window so the chart's first paint costs no second request) — but
 * putting it in the KEY would mean a range flip re-keys the bundle, re-suspends
 * all six bundle-backed cards to their skeletons, and sends a failed flip to the
 * route's error boundary. The chart owns its own narrow query precisely so a
 * range flip fetches *only* the range and fails *inside the card* (ADR-0915).
 *
 * `leagueId` is `undefined` for the **default league**, which is what the URL
 * carries no `?league=` for — so the default key stays exactly what it was
 * before leagues existed, and every default-league caller (the route loader, the
 * full-history route) keeps hitting the same cache entry.
 */
export function playerQueryKey(playerId: string, leagueId?: string) {
  return ['players', 'detail', playerId, leagueId ?? null] as const
}

/**
 * The rating chart's cache key — **player + league + range**.
 *
 * The chart is the one card on the profile that does not project off the bundle,
 * so this is a key of its own (ADR-0915). All three parts vary its answer: a
 * rating is a fact about one ladder, and the window is the question being asked.
 *
 * `range` is normalized, never left `undefined`: the default range is what a URL
 * with no `?range=` means, so `(id, league, undefined)` and `(id, league, '90d')`
 * are the same window and must not become two cache entries — one of which would
 * then miss the seed the bundle plants and fetch again.
 */
export function ratingHistoryQueryKey(
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) {
  return [
    'players',
    'rating-history',
    playerId,
    leagueId ?? null,
    range ?? DEFAULT_RATING_RANGE,
  ] as const
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
 *
 * `range` names the calendar window the bundle's embedded `rating_history` block
 * is for — the chart's `?range=`. It is in the *request* but NOT in the key (see
 * `playerQueryKey`), so it must be passed by **every** card that reads the
 * bundle, exactly as `leagueId` must: they share one cache entry, so whichever of
 * them happens to trigger the fetch decides which window comes back inside it.
 *
 * **The fetch seeds the chart's cache.** That is what lets the chart paint on
 * first load without a request of its own, and the seeding happens *here*, in the
 * `queryFn`, rather than in the card — because only the fetch knows which window
 * it asked for.
 *
 * The card cannot know. The bundle's key deliberately excludes the range (a range
 * flip must not re-suspend the six cards that project off it), so a *cached*
 * bundle carries a window whose range nothing records: a card reading
 * `rating_history` out of the cache to seed itself can be handed the 30-day window
 * a previous visit fetched and file it under "90d", drawing one window beneath
 * another window's caption with no request left to correct it. Seeding from the
 * fetch cannot go wrong that way — the worst it can do is *not* seed, and an
 * unseeded chart simply fetches its own window (one narrow request, right data).
 */
export function playerByIdQueryOptions(
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) {
  return queryOptions({
    queryKey: playerQueryKey(playerId, leagueId),
    queryFn: async ({ client }): Promise<PlayerDetail> => {
      const player: PlayerDetail = unwrap(
        'load player',
        await api.GET('/v1/players/{player_id}', {
          params: {
            path: { player_id: playerId },
            query: { league_id: leagueId, range },
          },
        }),
      )
      // Hand the embedded window to the chart's own cache, under the key for the
      // range THIS request named. `client` is the client the query is running on,
      // so this is correct under the app's singleton and under a test's throwaway
      // one alike.
      client.setQueryData(
        ratingHistoryQueryKey(playerId, leagueId, range),
        player.rating_history,
      )
      return player
    },
    retry: false,
    throwOnError: true,
  })
}

export function usePlayerById(
  playerId: string,
  options: { enabled?: boolean; leagueId?: string; range?: RatingRange } = {},
) {
  const { leagueId, range, ...queryOverrides } = options
  return useQuery({
    ...playerByIdQueryOptions(playerId, leagueId, range),
    ...queryOverrides,
  })
}

/**
 * The profile's rating chart — one player's rating over one **calendar window**
 * on one ladder (ADR-0915). The one query on the profile that is not a projection
 * off the BFF bundle, because a range flip must fetch *only* the range.
 *
 * Three things it deliberately does **not** do, each of which the chart's
 * behaviour depends on:
 *
 * - **No `throwOnError`.** A failed range flip renders "Couldn't load that range ·
 *   Try again" *inside the card* and leaves the rest of the painted profile
 *   alone. Blanking a whole profile because someone clicked "30d" would be absurd
 *   — which is also why the card cannot use `useSuspenseQuery` (there is no
 *   `throwOnError: false` for it, and a key change re-suspends it to a skeleton
 *   instead of holding the old chart).
 * - **No fetch on first paint.** The caller seeds `initialData` from the profile
 *   bundle's embedded `rating_history` for the range the page loaded with — the
 *   same trick that used to hydrate the matches table's page 1 from the bundle.
 * - **No instant refetch of that seed.** `staleTime` is set explicitly here, since
 *   seeded-but-stale data would be refetched on mount and cost the very request
 *   the seed avoids.
 */
export function ratingHistoryQueryOptions(
  playerId: string,
  options: { leagueId?: string; range?: RatingRange } = {},
) {
  const { leagueId, range } = options
  return queryOptions({
    queryKey: ratingHistoryQueryKey(playerId, leagueId, range),
    queryFn: async (): Promise<RatingHistoryWindow> =>
      unwrap(
        'load rating history',
        await api.GET('/v1/players/{player_id}/rating-history', {
          params: {
            path: { player_id: playerId },
            query: { league_id: leagueId, range },
          },
        }),
      ),
    staleTime: RATING_HISTORY_STALE_TIME,
    retry: false,
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
