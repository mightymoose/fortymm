import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'
import {
  formatRating,
  formatRankOfPopulation,
  formatRatingDelta,
  formatRatingDeltaAria,
} from '@/lib/rating'

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
  /** `null` when no rated match has *moved* the rating — either because there is
   * none, or because the only one there is *established* the rating (a null
   * `delta` inside a present `rating_change`). The chip is then suppressed
   * *entirely*: a player has not held steady at "+0" and has certainly not
   * fallen from the 1500 their league-join seeded — they simply have no delta
   * (#952). */
  delta: RatingDeltaView | null
  /** Peak, then one standing line — rank OR percentile, never both (ADR
   * 20260725). At or above the percentile threshold the standing line is the
   * percentile ("Top N%"); below it, where the API withholds the percentile, it
   * is the rank ("#N of M") in the same slot, so the profile and the dashboard
   * agree. Each present only when the player has it — an unrated player has none:
   * no rating, no rank (CONTEXT.md § *Rank*). */
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
  // Two nulls reach us here and both suppress the chip, for two different
  // reasons:
  //   - no `rating_delta` at all → no rated match has moved this rating;
  //   - a `rating_delta` whose `delta` is null → the player's most recent rated
  //     match was their FIRST, so it *established* the rating rather than moving
  //     it. They did not gain or lose anything — there was nothing to gain from
  //     (#952). The hero already says the rating; a chip would have to invent a
  //     direction for it.
  if (ratingDelta == null) return null
  if (ratingDelta.delta === null) return null
  return {
    label: formatRatingDelta(ratingDelta.delta),
    ariaLabel: formatRatingDeltaAria(ratingDelta.delta),
    tone: ratingDelta.delta >= 0 ? 'win' : 'loss',
  }
}

const selectStats = (player: PlayerDetail): StandingStatView[] => {
  const stats: StandingStatView[] = []
  if (player.peak != null) {
    stats.push({ label: 'Peak', value: formatRating(player.peak) })
  }
  // The standing line — rank OR percentile, never both, so the profile and the
  // dashboard say the same thing (ADR 20260725). The API withholds `percentile`
  // while the league is too small for "Top N%" to mean anything and populates
  // `rank`/`rank_of` instead; its presence — not a threshold here — is the switch:
  //
  // - AT OR ABOVE the threshold the percentile is present and takes the slot;
  // - BELOW it the percentile is null, so the hero reads RANK ("#3 of 42") in the
  //   same slot — honest at any position and league size, where "Top 100%" for the
  //   last-place player of a small ladder was a compliment-shaped lie (#959).
  //
  // Rank is always reported *out of the rated population* — "#3 of 42", never a
  // naked "#3", which in a twelve-player league flatters: both halves or neither.
  if (player.percentile != null) {
    stats.push({ label: 'Percentile', value: `Top ${player.percentile}%` })
  } else if (player.rank != null && player.rank_of != null) {
    stats.push({
      label: 'Rank',
      value: formatRankOfPopulation(player.rank, player.rank_of),
    })
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
