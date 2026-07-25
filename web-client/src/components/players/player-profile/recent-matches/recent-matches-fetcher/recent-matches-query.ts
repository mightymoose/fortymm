import { matchDetailRoute } from '@/api/matches'
import {
  playerByIdQueryOptions,
  type PlayerDetail,
  type PlayerMatchRow,
  type RatingRange,
} from '@/api/players'
import type { MatchDetailRoute } from '@/components/matches/match-row-link/match-row-link'
import { matchRowAriaLabel } from '@/components/matches/match-row-link/match-row-naming'
import { formatRatingDelta, formatRatingDeltaAria } from '@/lib/rating'

/** The em dash the card prints wherever a number would lie: an unfinished
 * match has no score, and an undecided *or* unrated one has no rating change.
 * Never a "+0" (ADR-0915). */
export const NO_VALUE = '—'

/**
 * How many rows the overview card draws. The API already caps the bundle at six
 * (`PROFILE_RECENT_MATCHES`), so this is normally a no-op — but the card owns its
 * own shape: cap the projection here too, so a longer bundle from any code path
 * can never silently turn the overview into a long table. The full history lives
 * behind the "view all" link, on its own paginated surface. */
export const RECENT_MATCHES_SHOWN = 6

/** What the Opponent cell reads for a solo match — one with nobody on the other
 * side (ADR-0008). It is a name for an absence, not a player. */
export const NO_OPPONENT = 'No opponent'

/**
 * What the row's status dot says. With the result chip gone, this dot — and the
 * score cell — are the *only* things carrying a match's state, so it covers
 * every state the all-inclusive list can hold (ADR-0008).
 */
export type RecentMatchTone =
  | 'won'
  | 'lost'
  | 'awaiting'
  | 'live'
  | 'up_next'
  | 'voided'

export type RecentMatchStatusView = {
  tone: RecentMatchTone
  /** The dot's accessible name — it is the only won/lost signal a screen reader
   * gets, e.g. "Won" / "Live" / "Awaiting acceptance". */
  label: string
}

/** One game of a finished match, from the player's perspective. */
export type RecentMatchGameView = {
  mine: number
  theirs: number
  won: boolean
}

/**
 * The score cell. A finished match shows its per-game chips; an unfinished one
 * says what it is *doing* instead ("Live" / "Awaiting" / "—") rather than
 * implying a scoreline it doesn't have.
 */
export type RecentMatchScoreView =
  | { kind: 'games'; games: RecentMatchGameView[] }
  | { kind: 'text'; text: string }

/** The Δ cell's contents. `null` — rendered as `—` — for any row whose rating
 * did not *move*: undecided, unrated, or the player's first rated match (which
 * established the rating instead). */
export type RecentMatchDeltaView = {
  /** The terse signed figure, e.g. "+12" / "-14". */
  label: string
  /** Spelled out for a screen reader, e.g. "Gained 12 rating". */
  ariaLabel: string
  tone: 'win' | 'loss'
}

/**
 * Who the match was against — and, therefore, whether the cell is a **link**.
 *
 * A sum type, not a nullable id beside an `isSolo` flag: on the wire
 * (`PlayerMatchOpponent`) both `id` and `username` are nullable, because a
 * **solo** match has the player-less sentinel side on the other end (ADR-0008)
 * and there is nobody there to link to. A nullable id would let a row render
 * `/players/null`; here the id exists only on the variant that has a player, so
 * the link is unbuildable in the case that has none. (The client-side twin of
 * "no tri-state booleans".)
 */
export type RecentMatchOpponentView =
  | { kind: 'player'; id: string; name: string }
  | { kind: 'solo'; name: typeof NO_OPPONENT }

/**
 * One row of the card — and it carries **two** destinations, on purpose.
 *
 * A row is a match *and* a person, and the reader can want either. So the row
 * exposes both, each named for where it actually goes:
 *
 * - the **row** (its stretched anchor, on the date cell) opens the **match** —
 *   `detailRoute` + `ariaLabel`, "Match against ada.lovelace, Mar 14" (#989);
 * - the **opponent's name** opens that **player's profile** — `opponent`, when it
 *   is a `player` (#1005).
 *
 * That is two links a screen reader hears per row, not one heard twice: they are
 * different destinations, and each is named for its own. The name is *not* folded
 * into the row link precisely because "ada.lovelace", announced as a link, would
 * promise a profile and deliver a match.
 */
export type RecentMatchRowView = {
  id: string
  /** The opponent, and whether there is one: a `player` is linked to their
   * profile, a solo match reads "No opponent" as plain text. */
  opponent: RecentMatchOpponentView
  status: RecentMatchStatusView
  score: RecentMatchScoreView
  /** `null` when no rating moved: the display prints `—`, never "+0". */
  delta: RecentMatchDeltaView | null
  /** e.g. "Mar 14". `—` when the timestamp is unreadable. */
  when: string
  /** The `{to,params}` target of the row's link — the match's detail page. Built
   * here, from the typed `matchDetailRoute` factory, so the row component never
   * hand-writes a path (the same way `MatchListRowView` carries one). */
  detailRoute: MatchDetailRoute
  /** The **row** link's accessible name, e.g. "Match against ada.lovelace,
   * Mar 14". It names the match, because that is where the row goes; the
   * opponent's own name is a separate link, to their profile. */
  ariaLabel: string
}

export type RecentMatchesView = {
  /** For the footer link's route params. */
  playerId: string
  /** The six most recent matches the bundle carries, in the order it sent them.
   * Never filtered — a live or voided match belongs on this card. */
  rows: RecentMatchRowView[]
  /** The **all-inclusive** history count (`match_total`), which is deliberately
   * larger than the career's decided count whenever a match is in play. Do not
   * reconcile them (ADR-0915). */
  total: number
  /** e.g. "View all 50 matches". */
  viewAllLabel: string
}

/**
 * "Mar 14" — dated in `timeZone`, which **defaults to the reader's local zone**.
 *
 * The day you played a match is a *local* fact, and it must agree with every other
 * surface that dates the same match: the full history page
 * (`player-match-history.tsx`) and the match-detail page both render local. This
 * card formatted in UTC, so a match played at 7:15pm in Chicago — already tomorrow
 * in UTC — was dated a day ahead of both of them, and two matches played fifteen
 * minutes apart could land on two different days *in the same table*.
 *
 * (The hero's "Member since" *is* UTC on purpose, and stays that way: a join month
 * is a fact about the account, not about the reader's evening.)
 *
 * The zone is a **parameter, not ambient state**. Production passes none —
 * `undefined` is exactly what `Intl` reads as "the runtime's zone", so the reader
 * still gets their own local day (and `recentMatchesQuery` below passes the
 * projection to `select` by reference, so there is nowhere for a zone to sneak in).
 * A test names the zone instead, and can then assert a real, *zone-independent*
 * claim — the same instant is Jul 11 in Chicago and Jul 12 in Tokyo — rather than
 * betting on the process's ambient `TZ`, which a mutation runner does not honour.
 *
 * Formatted per call rather than through a hoisted `Intl.DateTimeFormat`: a
 * formatter built at module load resolves — and then caches — the timezone that was
 * current when it was constructed.
 */
const selectWhen = (iso: string, timeZone?: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return NO_VALUE
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone,
  })
}

const selectStatus = (row: PlayerMatchRow): RecentMatchStatusView => {
  // A posted-but-unaccepted result and a genuinely-live match both sit at
  // `in_progress`, so the awaiting flag is checked first (#364).
  if (row.awaiting_acceptance) {
    return { tone: 'awaiting', label: 'Awaiting acceptance' }
  }
  if (row.status === 'in_progress') return { tone: 'live', label: 'Live' }
  if (row.status === 'pending') return { tone: 'up_next', label: 'Up next' }
  if (row.status === 'voided') return { tone: 'voided', label: 'Voided' }
  if (row.result === 'W') return { tone: 'won', label: 'Won' }
  if (row.result === 'L') return { tone: 'lost', label: 'Lost' }
  // Completed but decided nothing. Neutral, like a void — it is not a win.
  return { tone: 'voided', label: 'No result' }
}

const selectScore = (row: PlayerMatchRow): RecentMatchScoreView => {
  // The score cell must not lie about a match that hasn't finished: where a
  // scoreline would go, an unfinished match says what it is doing. A live match
  // can already have games on the board — they are not a result.
  if (row.awaiting_acceptance) return { kind: 'text', text: 'Awaiting' }
  if (row.status === 'in_progress') return { kind: 'text', text: 'Live' }
  if (row.status !== 'completed' || row.games.length === 0) {
    return { kind: 'text', text: NO_VALUE }
  }
  return {
    kind: 'games',
    games: row.games.map((game) => ({
      mine: game.mine,
      theirs: game.theirs,
      won: game.mine > game.theirs,
    })),
  }
}

const selectDelta = (
  ratingChange: PlayerMatchRow['rating_change'],
): RecentMatchDeltaView | null => {
  // Keyed on the field alone, never on the status: a *completed, decided* win in
  // an unrated match moved no rating either, and it must read `—` too.
  if (ratingChange == null) return null
  // And a present change with a null `delta` is the player's FIRST rated match:
  // it *established* their rating rather than moving it. The Δ column measures
  // movement, and nothing moved — so `—`, not a signed number off the seeded
  // 1500 they never held (#952). The row still shows its result and score; the
  // match-detail page is where the new rating is spelled out (`Unrated → X`).
  if (ratingChange.delta === null) return null
  return {
    label: formatRatingDelta(ratingChange.delta),
    ariaLabel: formatRatingDeltaAria(ratingChange.delta),
    tone: ratingChange.delta >= 0 ? 'win' : 'loss',
  }
}

/**
 * The opponent cell, and with it the row's *second* navigation.
 *
 * The id is **already on the wire** — the card simply dropped it, which is what
 * made every opponent's name a dead end. Projecting it is the whole fix; the
 * only subtlety is the case where there is no id to project.
 *
 * Both halves or nothing. A `player` is built only when the id *and* the username
 * are there, so the id the row links to cannot be `null`/`undefined` — the type
 * makes `/players/null` unbuildable rather than merely unlikely. The API nulls the
 * two together (`PlayerMatchOpponent`: "``id`` and ``username`` are both ``None``
 * for the player-less sentinel side"), so in practice this is exactly the solo
 * match; and a payload that somehow named an opponent without identifying them
 * degrades to the unlinkable cell rather than to a broken link.
 */
const selectOpponent = (
  opponent: PlayerMatchRow['opponent'],
): RecentMatchOpponentView =>
  opponent.id != null && opponent.username != null
    ? { kind: 'player', id: opponent.id, name: opponent.username }
    : { kind: 'solo', name: NO_OPPONENT }

const selectRow = (
  row: PlayerMatchRow,
  timeZone?: string,
): RecentMatchRowView => {
  const opponent = selectOpponent(row.opponent)
  const when = selectWhen(row.created_at, timeZone)
  return {
    id: row.id,
    opponent,
    status: selectStatus(row),
    score: selectScore(row),
    delta: selectDelta(row.rating_change),
    when,
    // The row is a link to its match (#989). Both halves of that link are
    // *derived data*, so they belong here rather than in the row component: the
    // target comes off the typed route factory, and the accessible name is
    // composed from the same two labels the row already prints — so the thing a
    // screen reader hears can never drift from the thing on screen.
    detailRoute: matchDetailRoute(row.id),
    ariaLabel: matchRowAriaLabel({
      opponent: opponent.name,
      isSolo: opponent.kind === 'solo',
      when,
    }),
  }
}

/**
 * `timeZone` names the zone the match days are dated in. **Omit it in production**
 * — that is what makes the card read in the reader's own local day (see
 * `selectWhen`). Tests pass one so the day they assert is a fact about the code,
 * not about the machine running it.
 */
export const selectRecentMatches = (
  player: PlayerDetail,
  timeZone?: string,
): RecentMatchesView => {
  const total = player.match_total
  return {
    playerId: player.id,
    // Unfiltered — every state belongs on the card — but capped: the card draws
    // the six most recent, no matter how long a bundle it is handed. The API
    // already sends six; the slice makes that the card's own contract rather than
    // a promise it merely trusts the server to keep.
    rows: player.matches.items
      .slice(0, RECENT_MATCHES_SHOWN)
      .map((row) => selectRow(row, timeZone)),
    total,
    // "View all 1 match" reads wrong — "all" presupposes more than one — so the
    // lone-match case drops both the count and the "all".
    viewAllLabel: total === 1 ? 'View match' : `View all ${total} matches`,
  }
}

/**
 * The profile's "Recent matches" card, projected off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select` — same key, same fetch,
 * its own view model — so the card costs **no second request**: it reads the six
 * matches the bundle already carries, off the very cache entry the hero reads
 * (the match-details projection pattern). The full paginated history is a
 * different surface with a different query (`/players/$userId/matches`).
 *
 * The projection is handed to `select` **by reference**, on purpose: React Query
 * calls it as `select(data)`, so its `timeZone` is `undefined` and the dates come
 * out in the reader's own zone. Wrapping it — `select: (p) => selectRecentMatches(p, …)`
 * — would be the way to hand this card a zone the rest of the page doesn't use,
 * which is the bug. A test pins the identity.
 */
export const recentMatchesQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectRecentMatches,
})
