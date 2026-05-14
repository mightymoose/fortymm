import { useMutation, useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type Player = components['schemas']['PlayerRead']
export type Match = components['schemas']['MatchRead']
export type MatchCreate = components['schemas']['MatchCreate']

export const PLAYERS_QUERY_KEY = ['players'] as const

/** Registered users the signed-in player can pick as an opponent. */
export function usePlayers() {
  return useQuery({
    queryKey: PLAYERS_QUERY_KEY,
    queryFn: async (): Promise<Player[]> =>
      unwrap('load players', await api.GET('/v1/players')),
    staleTime: 1000 * 60 * 5,
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
