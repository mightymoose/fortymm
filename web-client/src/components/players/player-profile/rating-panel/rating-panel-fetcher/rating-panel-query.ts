import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'
import { formatRatingDelta, formatRatingDeltaAria } from '@/lib/rating'

/** One decided match's outcome, newest first. */
export type FormResult = 'W' | 'L'

/** The player's last ten decided matches. `label` names exactly what is on
 * screen ("Last 10: W W L …"), so a short history is announced honestly. */
export type FormChipsView = {
  results: FormResult[]
  label: string
}

/** The Δ chip beside the rating: how far the player's most recent *rated* match
 * moved them. */
export type RatingDeltaView = {
  /** The terse signed figure, e.g. "+12" / "-8". */
  label: string
  /** Spelled out for a screen reader, e.g. "Gained 12 rating". */
  ariaLabel: string
  tone: 'win' | 'loss'
}

/** One label/value line under the rating (Rank, Peak, Percentile). Only the
 * lines the player actually has are present. */
export type StandingStatView = {
  label: string
  value: string
}

export type RatingPanelView = {
  /** The rounded league rating, or `null` for a player who has never finished a
   * rated match — the display reads "Unrated". */
  rating: number | null
  /** `null` when there is no rated match to have moved the rating. The chip is
   * then suppressed *entirely*: a player with no rating history has not held
   * steady at "+0", they simply have no delta (`RatingChange | None` on the
   * wire — never a zero). */
  delta: RatingDeltaView | null
  /** Rank, peak and percentile, in that order — each present only when the
   * player has it. An unrated player has none of them: no rating, no rank
   * (CONTEXT.md § *Rank*). */
  stats: StandingStatView[]
  /** `null` for a player with no decided matches at all. Independent of the
   * rating: form counts decided matches, rated or not. */
  form: FormChipsView | null
}

/** How many results the profile shows. The wire carries ten (`FORM_WINDOW` in
 * api/app/players.py) and the profile is what they are for — the `/players`
 * roster is the surface that slices them back to five. */
const PROFILE_FORM_RESULTS = 10

const selectForm = (form: string): FormChipsView | null => {
  // The wire's form is a bare string; take only the results we understand and
  // cap it, so a longer or dirtier window than expected can't spray the hero.
  const results = form
    .split('')
    .filter((c): c is FormResult => c === 'W' || c === 'L')
    .slice(0, PROFILE_FORM_RESULTS)
  if (results.length === 0) return null
  return {
    results,
    label: `Last ${results.length}: ${results.join(' ')}`,
  }
}

const selectDelta = (
  ratingDelta: PlayerDetail['rating_delta'],
): RatingDeltaView | null => {
  if (ratingDelta == null) return null
  return {
    label: formatRatingDelta(ratingDelta.delta),
    ariaLabel: formatRatingDeltaAria(ratingDelta.delta),
    tone: ratingDelta.delta >= 0 ? 'win' : 'loss',
  }
}

const selectStats = (player: PlayerDetail): StandingStatView[] => {
  const stats: StandingStatView[] = []
  // Rank is always reported *out of the rated population* — "#3 of 42", never a
  // naked "#3", which in a twelve-player league flatters. Both halves or
  // neither.
  if (player.rank != null && player.rank_of != null) {
    stats.push({ label: 'Rank', value: `#${player.rank} of ${player.rank_of}` })
  }
  if (player.peak != null) {
    stats.push({ label: 'Peak', value: String(Math.round(player.peak)) })
  }
  // The API withholds the percentile while the league is too small for it to
  // mean anything, so its presence — not a threshold here — is the signal.
  if (player.percentile != null) {
    stats.push({ label: 'Percentile', value: `Top ${player.percentile}%` })
  }
  return stats
}

export const selectRatingPanel = (player: PlayerDetail): RatingPanelView => ({
  rating: player.rating == null ? null : Math.round(player.rating),
  delta: selectDelta(player.rating_delta),
  stats: selectStats(player),
  form: selectForm(player.form),
})

/**
 * The hero's standing card — rating, Δ, rank-of-ladder, peak, form — projected
 * off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select`: same key, same fetch, a
 * different view model. The hero's two cards therefore share ONE cache entry and
 * cost ONE request (the match-details projection pattern).
 */
export const ratingPanelQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectRatingPanel,
})
