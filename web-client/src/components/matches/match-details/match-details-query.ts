import { api, unwrap } from '@/api/client'
import type { MatchDetails } from '@/api/matches'

export function matchQueryKey(matchId: string) {
  return ['matches', 'detail', matchId] as const
}

export function matchDetailsQuery(matchId: string) {
  return {
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
  }
}
