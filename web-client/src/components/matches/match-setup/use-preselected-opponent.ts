import { useQuery } from '@tanstack/react-query'

import { playerByIdQueryOptions } from '@/api/players'
import { useSession } from '@/api/session'

import type { Opponent } from './opponent'

export interface PreselectedOpponent {
  /** The resolved opponent, or `null` when there is nothing to preselect (no
   * id in the URL) or the id doesn't resolve to a player. */
  opponent: Opponent | null
  /** True while an id from the URL is still being resolved. Callers hold the
   * opponent slot on this rather than rendering the picker, so a preseeded
   * arrival doesn't flash the empty picker (and fire its recent-opponents
   * fetch) before the player lands. */
  isResolving: boolean
}

/**
 * Resolve the `?opponent=<userId>` search param on `/matches/new` into a real
 * opponent, so a "Start a match" link from a player's profile lands with that
 * player already picked.
 *
 * Reuses the profile page's `playerByIdQueryOptions` — same cache key, so
 * arriving from a profile that already fetched the player resolves from cache
 * with no second request.
 *
 * Deliberately **not** `throwOnError`: an unknown id must degrade to the empty
 * picker, not throw the whole match-creation page into an error boundary. A
 * failed lookup (404, 401, network) is simply "nothing to preselect".
 *
 * Gated on the session for the same reason `RecentOpponents` is — a cold
 * direct-load of the URL would otherwise race the session cookie and 401 (#98).
 */
export function usePreselectedOpponent(
  opponentId: string | undefined,
): PreselectedOpponent {
  const session = useSession()
  const wanted = opponentId !== undefined
  const query = useQuery({
    ...playerByIdQueryOptions(opponentId ?? ''),
    enabled: wanted && session.isSuccess,
    throwOnError: false,
  })

  const player = query.data ?? null

  return {
    opponent: player
      ? { id: player.id, name: player.username, rating: player.rating }
      : null,
    // `isLoading` (not `isPending`) is the "actually fetching" flag: a disabled
    // query stays `isPending` forever, which would pin the skeleton up on the
    // ordinary no-param page. The session leg is separate because the lookup is
    // still disabled — hence not loading — while the session resolves.
    isResolving: wanted && (session.isPending || query.isLoading),
  }
}
