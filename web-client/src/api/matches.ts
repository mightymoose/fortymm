import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api, unwrap } from './client'
import { DASHBOARD_QUERY_KEY } from './dashboard'
import type { components } from './schema'

export type Player = components['schemas']['PlayerRead']
export type MatchCreate = components['schemas']['MatchCreate']
export type MatchDetails = components['schemas']['MatchDetails']
export type MatchListResponse = components['schemas']['MatchListResponse']
export type MatchListRow = components['schemas']['MatchListRow']
export type MatchGameScoreWrite = components['schemas']['MatchGameScoreWrite']
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

/** Query key for a single match's details (BFF response). */
export function matchQueryKey(matchId: string) {
  return ['matches', 'detail', matchId] as const
}

/**
 * Opponents to feature in the new-match picker, most-recently-played first
 * (backfilled with other registered players by the API). Errors are thrown so
 * the surrounding error boundary can render a retry affordance.
 */
export function useRecentOpponents() {
  return useQuery({
    queryKey: RECENT_OPPONENTS_QUERY_KEY,
    queryFn: async (): Promise<Player[]> =>
      unwrap('load recent opponents', await api.GET('/v1/players/recent')),
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
export function useMatchList(params: MatchListParams) {
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
    placeholderData: keepPreviousData,
    retry: false,
    throwOnError: true,
  })
}

/**
 * Single match details (BFF for /matches/$id and the scoring routes).
 * Throws to the surrounding boundary on failure.
 */
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
 * Writes the first score for a game. The scoring route surfaces errors
 * inline, so `throwOnError` is intentionally omitted — callers branch on
 * `mutation.error`.
 */
export function useCreateScore(matchId: string, gameId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: MatchGameScoreWrite): Promise<MatchDetails> =>
      unwrap(
        'submit score',
        await api.POST('/v1/matches/{match_id}/games/{game_id}/scores', {
          params: { path: { match_id: matchId, game_id: gameId } },
          body: input,
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Edits an existing score. Same cache work and same no-throw posture as
 * `useCreateScore` — the edit route handles errors inline.
 */
export function useUpdateScore(
  matchId: string,
  gameId: string,
  scoreId: string,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: MatchGameScoreWrite): Promise<MatchDetails> =>
      unwrap(
        'update score',
        await api.PUT(
          '/v1/matches/{match_id}/games/{game_id}/scores/{score_id}',
          {
            params: {
              path: {
                match_id: matchId,
                game_id: gameId,
                score_id: scoreId,
              },
            },
            body: input,
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

// URL helpers used by every scoring CTA so the route shape lives in one place.
// `as const` preserves the literal `to` for TanStack Router's typed navigation.

export function scoringNewRoute(matchId: string, gameId: string) {
  return {
    to: '/matches/$matchId/games/$gameId/scores/new' as const,
    params: { matchId, gameId },
  }
}

export function scoringEditRoute(
  matchId: string,
  gameId: string,
  scoreId: string,
) {
  return {
    to: '/matches/$matchId/games/$gameId/scores/$scoreId/edit' as const,
    params: { matchId, gameId, scoreId },
  }
}
