import {
  playerByIdQueryOptions,
  type PlayerDetail,
  type PlayerMatchRow,
  type RatingRange,
} from '@/api/players'
import { formatRatingDelta, formatRatingDeltaAria } from '@/lib/rating'

/** The em dash the card prints wherever a number would lie: an unfinished
 * match has no score, and an undecided *or* unrated one has no rating change.
 * Never a "+0" (ADR-0915). */
export const NO_VALUE = '—'

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

/** The Δ cell's contents. `null` — rendered as `—` — for any row that is
 * undecided *or* unrated. */
export type RecentMatchDeltaView = {
  /** The terse signed figure, e.g. "+12" / "-14". */
  label: string
  /** Spelled out for a screen reader, e.g. "Gained 12 rating". */
  ariaLabel: string
  tone: 'win' | 'loss'
}

export type RecentMatchRowView = {
  id: string
  /** The opponent's username — or "No opponent" for a solo match, which stays
   * in the history rather than being dropped. */
  opponent: string
  isSolo: boolean
  status: RecentMatchStatusView
  score: RecentMatchScoreView
  /** `null` when no rating moved: the display prints `—`, never "+0". */
  delta: RecentMatchDeltaView | null
  /** e.g. "Mar 14". `—` when the timestamp is unreadable. */
  when: string
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
 * "Mar 14" — in the reader's **local** timezone.
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
 * Formatted per call rather than through a hoisted `Intl.DateTimeFormat`: a
 * formatter built at module load resolves — and then caches — the timezone that was
 * current when it was constructed.
 */
const selectWhen = (iso: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return NO_VALUE
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
  return {
    label: formatRatingDelta(ratingChange.delta),
    ariaLabel: formatRatingDeltaAria(ratingChange.delta),
    tone: ratingChange.delta >= 0 ? 'win' : 'loss',
  }
}

const selectRow = (row: PlayerMatchRow): RecentMatchRowView => ({
  id: row.id,
  opponent: row.opponent.username ?? 'No opponent',
  isSolo: row.opponent.username === null,
  status: selectStatus(row),
  score: selectScore(row),
  delta: selectDelta(row.rating_change),
  when: selectWhen(row.created_at),
})

export const selectRecentMatches = (player: PlayerDetail): RecentMatchesView => {
  const total = player.match_total
  return {
    playerId: player.id,
    // Straight through, unfiltered: the bundle already sent the six most recent,
    // and every state in them belongs on the card.
    rows: player.matches.items.map(selectRow),
    total,
    viewAllLabel: `View all ${total} ${total === 1 ? 'match' : 'matches'}`,
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
 */
export const recentMatchesQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectRecentMatches,
})
