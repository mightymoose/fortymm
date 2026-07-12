import { useSuspenseQuery } from '@tanstack/react-query'

import type { RatingRange } from '@/api/players'

import { HeadToHeadCardDisplay } from './head-to-head-card-fetcher/head-to-head-card-display'
import { headToHeadCardQuery } from './head-to-head-card-fetcher/head-to-head-card-query'

export interface HeadToHeadCardFetcherProps {
  playerId: string
  /** The ladder this card's *bundle* is about (ADR-0915), from the profile's
   * `?league=`. Nothing in this card's view varies with it — a meeting is a
   * decided match in any league — but it is part of the bundle's query key, so
   * every card on the page must be handed the same one or the profile forks into
   * two requests. */
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
 * Thin fetcher: reads the head-to-head view off the profile bundle's shared cache
 * entry — the same entry the hero, Career, confidence, Leagues and Recent-matches
 * cards read — and hands it to the display. No second request.
 *
 * **It does not ask the SESSION who is looking, and that is deliberate.** No card
 * on this page does: the session is a plain query that does not suspend, so it is
 * still in flight when a card that *did* suspend on the bundle paints, and a
 * component branching on it renders its first frames for the wrong viewer. Here
 * that would be the card's whole *structure*: on your own profile this card would
 * spend those frames trying to render a "You're 1–4 against…" block off a record
 * the API deliberately did not send. (The confidence card, whose voice turns on the
 * same bit, once read it from the session and flashed the wrong pronoun; it now
 * reads the payload, like this one.) The
 * payload answers the same question with no such gap — the API omits
 * `versus_viewer` exactly when the caller *is* the player (ADR-0915) — so the
 * structure is read from the data, which is also the only source that can be
 * *right*, since the server is the one who decided.
 */
export function HeadToHeadCardFetcher({
  playerId,
  leagueId,
  range,
}: HeadToHeadCardFetcherProps) {
  const { data: headToHead } = useSuspenseQuery(
    headToHeadCardQuery(playerId, leagueId, range),
  )

  return <HeadToHeadCardDisplay headToHead={headToHead} />
}
