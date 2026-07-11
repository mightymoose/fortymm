import { useSuspenseQuery } from '@tanstack/react-query'

import type { RatingRange } from '@/api/players'

import { LeaguesCardDisplay } from './leagues-card-fetcher/leagues-card-display'
import { leaguesCardQuery } from './leagues-card-fetcher/leagues-card-query'

export interface LeaguesCardFetcherProps {
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
 * Thin fetcher: reads the leagues view off the profile bundle's shared cache
 * entry — the same entry the hero, the rating panel, the Career card and the
 * Recent-matches card read — and hands it to the display. No second request: the
 * bundle already carries the player's leagues.
 *
 * `leagueId` does double duty here, and that is the whole mechanism of the
 * switcher: it is part of the **query key**, so picking a league re-keys the
 * bundle and refetches the rating half of the page; and it goes on to the card,
 * which highlights the row it names. One prop, one request, both halves of "the
 * selection is in the URL" (ADR-0915).
 *
 * The second half is a *prop*, not a field on the projected view, on purpose: the
 * bundle carries the same `leagues` list whichever league was asked for, so the
 * selection is a fact about the URL and the `select` stays a stable, response-only
 * function of the payload.
 */
export function LeaguesCardFetcher({
  playerId,
  leagueId,
  range,
}: LeaguesCardFetcherProps) {
  const { data: leagues } = useSuspenseQuery(leaguesCardQuery(playerId, leagueId, range))

  return (
    <LeaguesCardDisplay
      leagues={leagues}
      playerId={playerId}
      leagueId={leagueId}
    />
  )
}
