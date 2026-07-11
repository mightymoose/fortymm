import { playerByIdQueryOptions, type PlayerDetail } from '@/api/players'
import type { components } from '@/api/schema'

type PlayerLeague = components['schemas']['PlayerLeague']

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
  /** The ladder the rest of the page is currently bound to. Exactly one row is
   * selected, always. */
  isSelected: boolean
}

export type LeaguesView = {
  rows: LeagueRowView[]
}

/** Rating points are whole numbers; an absent rating is an em dash. */
const formatRating = (rating: number | null | undefined): string =>
  rating == null ? '—' : String(Math.round(rating))

/**
 * Which league the page is bound to.
 *
 * `leagueId` is what the URL asked for — and the fallback chain is what keeps a
 * nonsense `?league=` from producing a card with **no** row highlighted:
 *
 * 1. the league the URL named, if the player is actually in it;
 * 2. otherwise the **default** league — the one the API answers with when the
 *    caller names none, so this is the row the rest of the page is genuinely
 *    showing (`CONTEXT.md` § *Default league*);
 * 3. otherwise the first row, so a player whose leagues somehow carry no default
 *    still gets a coherent card rather than a dead one.
 *
 * Step 2 matters beyond mangled URLs: a caller can name a league that *exists*
 * but that this player does not belong to. The API answers happily (with no
 * rating), and the card must not then claim they are on a ladder it isn't
 * showing a row for.
 */
const selectedLeagueId = (
  leagues: PlayerLeague[],
  leagueId: string | undefined,
): string | undefined => {
  const named = leagues.find((league) => league.id === leagueId)
  if (named) return named.id
  const fallback = leagues.find((league) => league.is_default) ?? leagues[0]
  return fallback?.id
}

/**
 * The Leagues card's view — every league this player belongs to, with the rating
 * they carry **on each**, and which one the page is bound to.
 *
 * The list on the wire is *not* scoped to the requested league: it is the same
 * whichever league was asked for. What varies is which row is **selected**, and
 * that is derived here, from the league the URL named (ADR-0915).
 *
 * The rows deliberately carry no *career* numbers. Career is cross-league — a
 * fact about the person, not the ladder — so there is nothing per-league to say
 * about it, and a W–L on these rows would imply the Career card changes when you
 * click one. It does not.
 */
export const selectLeagues = (
  player: PlayerDetail,
  leagueId: string | undefined,
): LeaguesView => {
  const selectedId = selectedLeagueId(player.leagues, leagueId)
  return {
    rows: player.leagues.map((league) => ({
      id: league.id,
      name: league.name,
      rating: formatRating(league.rating),
      isDefault: league.is_default,
      isSelected: league.id === selectedId,
    })),
  }
}

/**
 * The Leagues card, projected off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select` — same key, same fetch —
 * so the card costs no second request: `leagues` rides on the bundle every other
 * card already reads.
 *
 * `leagueId` is here twice over, and both are load-bearing:
 *
 * - it is part of the **key** (via `playerByIdQueryOptions`), because a league
 *   switch re-keys the whole bundle and refetches the rating half of the page in
 *   one request;
 * - it is closed over by the **select**, because it decides which row is
 *   highlighted — and that is a fact about the *URL*, not about the response.
 */
export const leaguesCardQuery = (playerId: string, leagueId?: string) => ({
  ...playerByIdQueryOptions(playerId, leagueId),
  select: (player: PlayerDetail): LeaguesView => selectLeagues(player, leagueId),
})
