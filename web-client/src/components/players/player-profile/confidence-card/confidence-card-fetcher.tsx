import { useSuspenseQuery } from '@tanstack/react-query'

import type { RatingRange } from '@/api/players'

import { useIsViewer } from '@/api/viewer'

import { ConfidenceCardDisplay } from './confidence-card-fetcher/confidence-card-display'
import { confidenceCardQuery } from './confidence-card-fetcher/confidence-card-query'

export interface ConfidenceCardFetcherProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
  /** The chart's calendar window (ADR-0915), from the profile's `?range=`.
   * `undefined` is the **default** window — the URL carries no param for it.
   *
   * It is **not** in the bundle's cache key (a range flip must not refetch the
   * bundle, or a failed flip would blank the page), but it *is* in the bundle's
   * request: the response embeds that window, and the chart seeds its own cache
   * from it. So every card must be handed the same range — whichever card's query
   * happens to trigger the shared fetch decides which window comes back in it. */
  range?: RatingRange
}

/**
 * Thin fetcher: reads the confidence view off the profile bundle's shared cache
 * entry — the very same entry the hero, the Career card and the Recent-matches
 * card read — and hands it to the display. No second request: the bundle already
 * carries the confidence block.
 *
 * It does two things the other cards don't.
 *
 * **It can render nothing.** A player who has never finished a rated match has no
 * rating, so there is nothing to be confident about and the API sends `null`. The
 * card then does not exist — the hero already says "Unrated", and a confidence
 * card for a rating that isn't there would be nonsense. Not an empty state: an
 * absent one.
 *
 * **It asks who is looking.** `useIsViewer` compares the session's own player id
 * to this profile's, and the display turns its copy to the second person when
 * they match (ADR-0915). The session is a plain (non-suspense) query on purpose:
 * this card must not be held hostage to it. If the session is slow or fails, the
 * card still paints — in the third person, which is the voice it is safe to be
 * wrong in.
 */
export function ConfidenceCardFetcher({ playerId, leagueId, range }: ConfidenceCardFetcherProps) {
  const { data: confidence } = useSuspenseQuery(confidenceCardQuery(playerId, leagueId, range))
  const isViewer = useIsViewer(playerId)

  if (!confidence) return null

  return <ConfidenceCardDisplay confidence={confidence} isViewer={isViewer} />
}
