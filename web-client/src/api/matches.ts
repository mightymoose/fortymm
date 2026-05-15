import { useMutation, useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type Player = components['schemas']['PlayerRead']
export type Match = components['schemas']['MatchRead']
export type MatchCreate = components['schemas']['MatchCreate']

export const RECENT_OPPONENTS_QUERY_KEY = ['players', 'recent'] as const

/** Query key for a player search; the term is part of the key so each query is
 * cached independently and `enabled` can gate the empty-term case. */
export function playerSearchQueryKey(term: string) {
  return ['players', 'search', term] as const
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
 * Pass an already-debounced term.
 */
export function usePlayerSearch(term: string) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: playerSearchQueryKey(trimmed),
    queryFn: async (): Promise<Player[]> =>
      unwrap(
        'search players',
        await api.GET('/v1/players/search', {
          params: { query: { q: trimmed } },
        }),
      ),
    enabled: trimmed.length > 0,
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
    mutationFn: async (input: MatchCreate): Promise<Match> =>
      unwrap('create match', await api.POST('/v1/matches', { body: input })),
  })
}
