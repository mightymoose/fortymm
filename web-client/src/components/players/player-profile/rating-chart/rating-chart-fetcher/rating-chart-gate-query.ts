import {
  playerByIdQueryOptions,
  type PlayerDetail,
  type RatingRange,
} from '@/api/players'

/**
 * The one question the chart card asks the **profile bundle**: does this player
 * have a rating on this ladder at all?
 *
 * It is not the chart's data — that comes from the card's own `/rating-history`
 * query, keyed on the range (ADR-0915). It is the card's *existence*. A player
 * who has never finished a rated match has no rating timeline, and drawing them
 * an empty pair of axes would be worse than drawing nothing: the slot shows an
 * "Unrated" panel instead, consistent with the hero, which says "Unrated", and
 * the confidence card, which does not render.
 *
 * Reading it off the bundle rather than off the history window is deliberate. An
 * unrated player and a rated one with an empty window both come back from
 * `/rating-history` with no points; only the bundle says *which*, and only the
 * bundle can say so **before** the chart has fetched anything — which is what
 * lets an unrated player's profile skip the rating-history request entirely.
 *
 * One **boolean**, not an object — the same shape `isOwnProfile` takes. Narrowing
 * the bundle to the single bit the card branches on is also what keeps the card
 * from re-rendering on every unrelated field of the bundle. The *rating* itself is
 * not needed here: the "Unrated" panel takes no props, and the chart's own payload
 * carries the number at the end of its line.
 */
export const selectChartGate = (player: PlayerDetail): boolean =>
  player.rating != null

/**
 * The gate, projected off the profile bundle — same key, same fetch, no second
 * request (the match-details projection pattern).
 *
 * `range` is threaded through for the reason every card threads it: it rides on
 * the *request* the six bundle-backed cards share, and the bundle's embedded
 * `rating_history` block — the one the chart seeds its cache from — is the window
 * for the range that request named.
 */
export const ratingChartGateQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectChartGate,
})
