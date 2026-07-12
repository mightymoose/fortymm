import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'
import { formatRating } from '@/lib/rating'

/** One row of the Leagues card — and one *control*: clicking it rebinds the
 * rating half of the profile to this ladder (ADR-0915). */
export type LeagueRowView = {
  /** The league's id. Goes into the URL as `?league=<id>` — except for the
   * default league, whose row deliberately links to a *clean* URL with no param
   * at all (see `isDefault`). */
  id: string
  name: string
  /**
   * The player's rating **on this ladder**, as the row prints it — or `'—'` when
   * they hold none here.
   *
   * An em dash, never a `0` and never the rating from another row: belonging to a
   * league and holding a rating on it are different facts (the API outer-joins
   * the rating, so a member awaiting their first rating still gets a row), and a
   * player rated 1687 in one league and unrated in another has no number to
   * borrow across.
   */
  rating: string
  /** The league every player is joined to on sign-up (`CONTEXT.md` § *Default
   * league*). Its row wears a "Default" badge — and it is the row the page falls
   * back to when the URL names no league, which is why selecting it *removes*
   * `?league=` rather than setting it. */
  isDefault: boolean
}

export type LeaguesView = {
  rows: LeagueRowView[]
}

/**
 * The Leagues card's view — every league this player belongs to, with the rating
 * they carry **on each**.
 *
 * Note what is *not* here: which row is **selected**. That is a fact about the
 * **URL**, not about the response — the list on the wire is the same whichever
 * league was asked for — so it is derived in the display, from the league the URL
 * named (ADR-0915). Deriving it here would mean closing this `select` over
 * `leagueId`, which makes it a *new function on every call*: TanStack memoizes a
 * `select` on its identity, so an inline arrow re-runs the projection and rebuilds
 * this whole view model on every render. This one is a stable module-level ref,
 * like every other card's on the page.
 *
 * The rows deliberately carry no *career* numbers. Career is cross-league — a
 * fact about the person, not the ladder — so there is nothing per-league to say
 * about it, and a W–L on these rows would imply the Career card changes when you
 * click one. It does not.
 */
export const selectLeagues = (player: PlayerDetail): LeaguesView => ({
  rows: player.leagues.map((league) => ({
    id: league.id,
    name: league.name,
    rating: formatRating(league.rating),
    isDefault: league.is_default,
  })),
})

/**
 * The Leagues card, projected off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select` — same key, same fetch —
 * so the card costs no second request: `leagues` rides on the bundle every other
 * card already reads.
 *
 * `leagueId` is here for one reason, not two: it is part of the **key** (via
 * `playerByIdQueryOptions`), because a league switch re-keys the whole bundle and
 * refetches the rating half of the page in one request. It is deliberately *not*
 * closed over by the `select` — see `selectLeagues` above — and travels to the
 * card as a prop instead, because which row is highlighted is a fact about the URL.
 */
export const leaguesCardQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectLeagues,
})
