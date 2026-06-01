import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api, resolveBaseUrl, unwrap } from './client'
import { DASHBOARD_QUERY_KEY } from './dashboard'
import type { components } from './schema'

export type Player = components['schemas']['PlayerRead']
export type MatchCreate = components['schemas']['MatchCreate']
// Two backend classes are named `MatchDetails` (the page BFF response and the
// new `data` view model), so openapi-typescript namespaces both by module path.
export type MatchDetails =
  components['schemas']['app__schemas__match__MatchDetails']
export type MatchDetailsView =
  components['schemas']['app__schemas__view__match_details__MatchDetails']
export type ScoreboardStatus = components['schemas']['Status']
export type MatchListResponse = components['schemas']['MatchListResponse']
export type MatchListRow = components['schemas']['MatchListRow']
export type MatchGameScoreWrite = components['schemas']['MatchGameScoreWrite']
export type MatchResultsWrite = components['schemas']['MatchResultsWrite']
export type MatchResultsGameWrite = components['schemas']['MatchResultsGameWrite']
export type MatchStatus = components['schemas']['MatchStatus']

export type MatchListParams = {
  status?: MatchStatus
  q?: string
  page: number
  page_size: number
}

export const RECENT_OPPONENTS_QUERY_KEY = ['players', 'recent'] as const

/** Query key for a player search; the term is part of the key so each query is
 * cached independently and `enabled` can gate the empty-term case. */
export function playerSearchQueryKey(term: string) {
  return ['players', 'search', term] as const
}

/** Query key for the paginated /matches list. The whole params bag is the
 * key so two different filters keep separate cache slots. */
export function matchListQueryKey(params: MatchListParams) {
  return ['matches', 'list', params] as const
}

export function matchQueryKey(matchId: string) {
  return ['matches', 'detail', matchId] as const
}

/**
 * Opponents to feature in the new-match picker, most-recently-played first
 * (backfilled with other registered players by the API). Errors are thrown so
 * the surrounding error boundary can render a retry affordance.
 */
export function useRecentOpponents(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: RECENT_OPPONENTS_QUERY_KEY,
    queryFn: async (): Promise<Player[]> =>
      unwrap('load recent opponents', await api.GET('/v1/players/recent')),
    // Gate on the session so a first-visit direct-load doesn't fire before the
    // session cookie lands and 401 into the error boundary (#98).
    enabled: options.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    // Fail fast to the error boundary's explicit "Try again" button rather
    // than silently retrying behind the skeleton.
    retry: false,
    throwOnError: true,
  })
}

/**
 * Server-side username search backing the opponent typeahead. The query is
 * disabled until `term` is non-empty, so an empty search box never hits the
 * network and the client never fetches the whole roster to filter locally.
 * Pass an already-trimmed, already-debounced term.
 */
export function usePlayerSearch(term: string) {
  return useQuery({
    queryKey: playerSearchQueryKey(term),
    queryFn: async (): Promise<Player[]> =>
      unwrap(
        'search players',
        await api.GET('/v1/players/search', {
          params: { query: { q: term } },
        }),
      ),
    enabled: term.length > 0,
    staleTime: 1000 * 60,
    // Keep the previous matches on screen while the next term loads, so the
    // dropdown doesn't flicker empty between keystrokes.
    placeholderData: (previous) => previous,
    // Fail fast to the error boundary's "Try again" rather than retrying.
    retry: false,
    throwOnError: true,
  })
}

/**
 * Creates a match. Callers await `mutateAsync` so they can surface the API's
 * 4xx `detail` inline on the form — no global error toast is attached here.
 */
export function useCreateMatch() {
  return useMutation({
    mutationFn: async (input: MatchCreate): Promise<MatchDetails> =>
      unwrap('create match', await api.POST('/v1/matches', { body: input })),
  })
}

/**
 * Paginated /matches list. `placeholderData: keepPreviousData` keeps the
 * current page rendered while the next page or filter resolves, so the table
 * doesn't flash empty between requests. Throws to the surrounding boundary.
 */
export function useMatchList(
  params: MatchListParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: matchListQueryKey(params),
    queryFn: async (): Promise<MatchListResponse> =>
      unwrap(
        'load matches',
        await api.GET('/v1/matches', {
          params: {
            query: {
              status: params.status,
              q: params.q,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      ),
    // Gate on the session so a first-visit direct-load doesn't fire before the
    // session cookie lands and 401 into the error boundary (#144).
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    retry: false,
    throwOnError: true,
  })
}

/**
 * URL of the CSV export for the current filters. The dedicated `/v1/matches.csv`
 * endpoint returns the whole filtered set as a `Content-Disposition: attachment`
 * download, so the UI can link straight to it — the browser downloads it
 * directly, with no client-side fetch/buffering.
 */
export function matchesCsvUrl(
  filters: Pick<MatchListParams, 'status' | 'q'>,
): string {
  const qs = new URLSearchParams()
  if (filters.status) qs.set('status', filters.status)
  if (filters.q) qs.set('q', filters.q)
  const query = qs.toString()
  return `${resolveBaseUrl()}/v1/matches.csv${query ? `?${query}` : ''}`
}

/** Throws on failure so the surrounding boundary can render a retry. */
export function useMatch(matchId: string) {
  return useQuery({
    queryKey: matchQueryKey(matchId),
    queryFn: async (): Promise<MatchDetails> =>
      unwrap(
        'load match',
        await api.GET('/v1/matches/{match_id}', {
          params: { path: { match_id: matchId } },
        }),
      ),
    retry: false,
    throwOnError: true,
  })
}

/** Cache work shared by both score mutations: prime the detail cache from the
 * mutation response and invalidate the list / dashboard so they re-read the
 * derived status, scoreboard, and next-up state. */
function applyScoreMutationCache(
  queryClient: ReturnType<typeof useQueryClient>,
  matchId: string,
  data: MatchDetails,
) {
  queryClient.setQueryData<MatchDetails>(matchQueryKey(matchId), data)
  queryClient.invalidateQueries({ queryKey: ['matches', 'list'] })
  queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })
}

/**
 * Writes the first score for a game (lazily inserting the MatchGame row).
 * Fire-and-forget: per-game writes are scratchpad-only — the canonical commit
 * lives in `POST .../results`, which obliterates and replaces the saved
 * scores. So we don't surface errors on these mutations.
 */
export function useCreateScore(matchId: string, gameNumber: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: MatchGameScoreWrite): Promise<MatchDetails> =>
      unwrap(
        'submit score',
        await api.POST(
          '/v1/matches/{match_id}/games/{game_number}/scores/new',
          {
            params: {
              path: { match_id: matchId, game_number: gameNumber },
            },
            body: input,
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Edits the saved score for a game. Same scratchpad-write posture as
 * `useCreateScore`.
 */
export function useUpdateScore(matchId: string, gameNumber: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: MatchGameScoreWrite): Promise<MatchDetails> =>
      unwrap(
        'update score',
        await api.PUT(
          '/v1/matches/{match_id}/games/{game_number}/scores',
          {
            params: {
              path: { match_id: matchId, game_number: gameNumber },
            },
            body: input,
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Clears the saved score for a game. Same scratchpad-write posture — failures
 * heal at finalize (the canonical /results POST is the source of truth).
 */
export function useDeleteScore(matchId: string, gameNumber: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'clear score',
        await api.DELETE(
          '/v1/matches/{match_id}/games/{game_number}/scores',
          {
            params: {
              path: { match_id: matchId, game_number: gameNumber },
            },
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Same as `useDeleteScore` but the game number is supplied at mutate-call
 * time — used by the scoreline's per-cell ✕, which needs to clear any logged
 * game from a single hook (hooks rules forbid one per cell).
 */
export function useDeleteScoreForMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (gameNumber: number): Promise<MatchDetails> =>
      unwrap(
        'clear score',
        await api.DELETE(
          '/v1/matches/{match_id}/games/{game_number}/scores',
          {
            params: {
              path: { match_id: matchId, game_number: gameNumber },
            },
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Posts the result of a match. The payload is canon — the server obliterates
 * any scratchpad-saved games + scores, inserts these, validates the match as
 * a decided whole, and records the caller's signature. For a non-solo match
 * the status stays `in_progress` until the other side confirms via
 * `POST /confirmation`; ratings apply on that final signature, not here.
 * Solo matches finalize immediately (no second party to attest).
 *
 * Unlike the per-game writes, this one's errors matter: pass
 * `throwOnError`-style handling at the call site so the user can see what
 * went wrong (most often a 422 if local validation drifted out of sync, or a
 * 409 if a result has already been posted).
 */
export function useFinalizeMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: MatchResultsWrite): Promise<MatchDetails> =>
      unwrap(
        'post match result',
        await api.POST('/v1/matches/{match_id}/results', {
          params: { path: { match_id: matchId } },
          body: input,
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Confirms a posted result. Inserts the caller's signature; when every side
 * has at least one signing player the server flips status to `completed` and
 * applies the rating update — exactly once. Caller must be a participant who
 * hasn't already signed (the BFF's `can_confirm` flag is the source of truth
 * for whether the CTA is shown).
 */
export function useConfirmMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'confirm match result',
        await api.POST('/v1/matches/{match_id}/confirmation', {
          params: { path: { match_id: matchId } },
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Disputes a posted result. Clears every signature on the match and resets
 * `side.won` to `null`; the canonical games stay in place so the disputer
 * can navigate to the contested game and PUT a corrected score. Status
 * stays `in_progress`. Same `can_confirm` predicate gates this as
 * `useConfirmMatch`.
 */
export function useDisputeMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'dispute match result',
        await api.POST('/v1/matches/{match_id}/dispute', {
          params: { path: { match_id: matchId } },
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

// `as const` on `to` preserves the literal so TanStack Router's typed
// navigation can validate it against the route tree.

export function matchDetailRoute(matchId: string) {
  return {
    to: '/matches/$matchId' as const,
    params: { matchId },
  }
}

export function scoringNewRoute(matchId: string, gameNumber: number) {
  return {
    to: '/matches/$matchId/games/$gameNumber/scores/new' as const,
    params: { matchId, gameNumber: String(gameNumber) },
  }
}

export function scoringEditRoute(matchId: string, gameNumber: number) {
  return {
    to: '/matches/$matchId/games/$gameNumber/scores/edit' as const,
    params: { matchId, gameNumber: String(gameNumber) },
  }
}

/** Where to land after writing a per-game score — the next un-scored slot, or
 * the match detail page when there's no next game (match finalized, or every
 * game has a saved score). */
export function nextScoringDestination(
  match: Pick<MatchDetails, 'id' | 'current_game'>,
) {
  return match.current_game
    ? scoringNewRoute(match.id, match.current_game.game_number)
    : matchDetailRoute(match.id)
}
