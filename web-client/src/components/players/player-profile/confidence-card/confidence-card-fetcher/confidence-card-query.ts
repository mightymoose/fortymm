import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'
import type { components } from '@/api/schema'

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
}

/** The level as a person reads it. */
const LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  provisional: 'Provisional',
  firming_up: 'Firming up',
  settled: 'Settled',
}

/** Rating points are whole numbers on the card — "somewhere between 1551.4 and
 * 1823.2" is false precision about a range that is itself an estimate. */
const formatRatingPoint = (value: number): string => String(Math.round(value))

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
 * second, drifting definition of the same fact.
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
      low: formatRatingPoint(confidence.interval.low),
      high: formatRatingPoint(confidence.interval.high),
    },
    details: [
      { label: 'Deviation (RD)', value: formatDeviation(confidence.deviation) },
      { label: 'Volatility (σ)', value: formatVolatility(confidence.volatility) },
    ],
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
