import { Suspense } from 'react'

import type { RatingRange } from '@/api/players'

import { LeaguesCardFetcher } from './leagues-card/leagues-card-fetcher'
import { LeaguesCardSkeleton } from './leagues-card/leagues-card-skeleton'

export interface LeaguesCardProps {
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
 * The profile's **Leagues** card — every ladder this player is on, the rating
 * they carry on each, and the page's **league switcher** (ADR-0915).
 *
 * The card that makes the rest of the page make sense: a rating, a rank, a peak
 * and a confidence are all facts about *one league*, so the page has to say which
 * — and this is where you change it. Clicking a row puts that league in the URL
 * and rebinds the whole rating half of the profile to it, in one refetch, because
 * the league is part of the bundle's query key. Career stays put: it is
 * cross-league by definition.
 *
 * Like the other cards it owns a `<Suspense>` with a hand-mirrored skeleton and
 * deliberately **no** error boundary: every card on the profile projects off the
 * same bundle query, so a failure means none of them has anything to draw and it
 * belongs to the route's `PlayerRouteError`.
 *
 * Unlike the confidence card, it always renders. Every player belongs to at least
 * one league — the default one they were joined to on sign-up — so there is no
 * empty state to design, and the single-row card a real user sees today is the
 * correct rendering, not a degenerate one.
 */
export function LeaguesCard({ playerId, leagueId, range }: LeaguesCardProps) {
  return (
    <Suspense fallback={<LeaguesCardSkeleton />}>
      <LeaguesCardFetcher
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    </Suspense>
  )
}
