import type { DashboardRating } from '@/api/dashboard'
import { formatRatingDelta } from '@/lib/rating'

export interface RatingCardStreakView {
  /** Badge label, e.g. "W3" or "L2". */
  label: string
  /** Win (green) vs loss (red) tint. */
  isWin: boolean
}

export interface RatingCardTileView {
  /** Stat name overline, e.g. "Peak", "RD". */
  label: string
  /** Pre-formatted stat value. */
  value: string
}

export interface RatingCardView {
  /** Rounded current rating for the hero numeral. */
  current: number
  /** Signed delta string for the "… last match" badge, e.g. "+24". */
  delta: string
  /** Whether the delta is non-negative — drives the badge tint. */
  deltaIsPositive: boolean
  /** League percentile (e.g. 78) or null when unranked — hides the "Top N%". */
  percentile: number | null
  /** League display name. */
  leagueName: string
  /** Rounded peak rating, shown in the sparkline footer. */
  peak: number
  /** Win/loss streak badge, or null when there is no active streak. */
  streak: RatingCardStreakView | null
  /** Sparkline points, padded to ≥2 so a freshly-rated single point still
   * draws a level baseline. */
  sparkPoints: number[]
  /** Up to three stat tiles: Peak followed by the strategy's own stats. */
  tiles: RatingCardTileView[]
}

/** Human label for a rating strategy key — used by the section subtitle. */
export function ratingStrategyLabel(key: string): string {
  if (key === 'glicko2') return 'Glicko-2'
  if (key === 'manual') return 'Manual'
  return key
}

/**
 * Project the BFF's rating payload into the card's view model: round the hero
 * numbers, format the delta and streak badges, and pad the sparkline / cap the
 * stat tiles. The card stays pure view-in.
 */
export function projectRatingCardView(rating: DashboardRating): RatingCardView {
  const { current, delta, peak, percentile, spark_data, streak, stats } = rating
  // The sparkline needs ≥2 points to draw a line; pad a single point so the
  // freshly-rated case still shows a level baseline.
  const sparkPoints =
    spark_data.length >= 2
      ? spark_data
      : [spark_data[0] ?? current, spark_data[0] ?? current]
  // Peak tile + whatever strategy-specific stats the API returned; capped at
  // three because the tile grid is three columns.
  const tiles: RatingCardTileView[] = [
    { label: 'Peak', value: String(Math.round(peak)) },
    ...stats,
  ].slice(0, 3)
  return {
    current: Math.round(current),
    delta: formatRatingDelta(delta),
    deltaIsPositive: delta >= 0,
    percentile,
    leagueName: rating.league_name,
    peak: Math.round(peak),
    streak: streak
      ? { label: `${streak.kind}${streak.n}`, isWin: streak.kind === 'W' }
      : null,
    sparkPoints,
    tiles,
  }
}
