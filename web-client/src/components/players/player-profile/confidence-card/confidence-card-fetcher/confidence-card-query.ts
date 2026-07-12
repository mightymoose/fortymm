import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'
import type { components } from '@/api/schema'
import { isOwnProfile } from '@/components/players/player-profile/profile-order'
import { formatRating } from '@/lib/rating'

type RatingConfidence = components['schemas']['RatingConfidence']

/** The three levels, in order (`CONTEXT.md` § *Rating confidence*). Keyed off the
 * rating's deviation by the API — the client never derives one. */
export type ConfidenceLevel = RatingConfidence['level']

/** The 95% interval, as the card prints it: whole rating points, low first. */
export type ConfidenceIntervalView = {
  /** e.g. "1551". */
  low: string
  /** e.g. "1823". */
  high: string
}

/** One row of the collapsed drawer: the Glicko-2 internals *behind* confidence,
 * for the curious. They are deliberately not on the card's face — RD and
 * volatility are not names for confidence, they are its machinery. */
export type ConfidenceDetailView = {
  label: string
  value: string
}

export type ConfidenceView = {
  level: ConfidenceLevel
  /** The level in **words**: "Provisional" / "Firming up" / "Settled". Never the
   * wire's `firming_up`, which is a key, not English. */
  levelLabel: string
  interval: ConfidenceIntervalView
  /** Deviation (RD), then Volatility (σ). */
  details: ConfidenceDetailView[]
  /**
   * Is the reader looking at **their own** profile? The card's copy turns on it,
   * and on nothing else: "A reliable read on where **you** stand" is right on your
   * own profile and a lie on a stranger's (ADR-0915). None of the numbers move.
   *
   * Read from the **payload**, via the same `isOwnProfile` predicate the page's
   * card order and the head-to-head card read — never from the session. The bundle
   * this card suspends on already carries the answer, so the copy is right on the
   * *first* frame. Branching on the session instead would paint the card before the
   * session lands and flash the wrong voice: the page's card order (payload) would
   * put Career first on your own profile while this card (session) still said "where
   * *they* stand".
   */
  isOwn: boolean
}

/** The level as a person reads it. */
const LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  provisional: 'Provisional',
  firming_up: 'Firming up',
  settled: 'Settled',
}

/** RD to one decimal, with no trailing ".0": 69.4, 350. */
const formatDeviation = (value: number): string =>
  String(Math.round(value * 10) / 10)

/** Glicko-2's sigma is a small number — 0.06 is a typical seed — so it needs the
 * decimals to say anything at all. */
const formatVolatility = (value: number): string => value.toFixed(4)

/**
 * The confidence view — or `null`, when the API sent none.
 *
 * `null` is not an empty state to fill in with dashes: confidence says how
 * settled a **rating** is, and a player who has never finished a rated match has
 * no rating to be settled (`CONTEXT.md` § *Rating confidence*). The card must not
 * render at all for them — the hero already says "Unrated", and an interval
 * around a rating that does not exist would be nonsense. The field is optional
 * *and* nullable on the wire, so this checks for both.
 *
 * Note what it does not compute: the interval. The API sends `rating ± 1.96·RD`
 * already worked out, and the level with it — deriving either here would be a
 * second, drifting definition of the same fact. *Who is looking* is the same story:
 * it is read straight off the payload (`isOwn`, above), never off the session.
 *
 * And note what does not exist, here or anywhere: a confidence **percentage**.
 * An "86%" is an arbitrary rescaling of RD onto a 0–100 axis that says nothing
 * the level and the interval don't say better. It was deliberately cut. Do not
 * add a bar, a percent or any other 0–100 anything back.
 */
export const selectConfidence = (player: PlayerDetail): ConfidenceView | null => {
  const confidence = player.confidence
  if (confidence == null) return null

  return {
    level: confidence.level,
    levelLabel: LEVEL_LABELS[confidence.level],
    interval: {
      low: formatRating(confidence.interval.low),
      high: formatRating(confidence.interval.high),
    },
    details: [
      { label: 'Deviation (RD)', value: formatDeviation(confidence.deviation) },
      { label: 'Volatility (σ)', value: formatVolatility(confidence.volatility) },
    ],
    isOwn: isOwnProfile(player),
  }
}

/**
 * The Rating confidence card, projected off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select` — **same key, same fetch**,
 * a different view model — so the card costs no second request: it reads the
 * confidence block the bundle already carries, off the very cache entry the hero,
 * the Career card and the Recent-matches card read.
 *
 * The key takes a player id and nothing else. In particular it does **not** vary
 * with the viewer: who is looking changes the card's *pronouns*, not its numbers
 * (ADR-0915), so the voice is a display concern and keying the cache on it would
 * fork one player's bundle into two identical entries.
 */
export const confidenceCardQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectConfidence,
})
