/**
 * A rating, as every surface prints one: **whole points**. "1687.4" is false
 * precision about a number that is itself an estimate.
 *
 * An absent rating is an **em dash**, never a `0` and never another ladder's
 * number: holding no rating on a league and being rated zero on it are different
 * facts (the API outer-joins the rating, so a member awaiting their first one
 * still gets a row).
 *
 * This is the plain figure. Its signed sibling — how far a *match* moved the
 * rating — is `formatRatingDelta` below, which is a different thing to say and
 * says it differently ("+12", never "12").
 */
export function formatRating(rating: number | null | undefined): string {
  return rating == null ? '—' : String(Math.round(rating))
}

export function formatRatingDelta(delta: number): string {
  const rounded = Math.round(delta)
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded}`
}

/** Screen-reader label for a rating delta, e.g. "Gained 8 rating" /
 * "Lost 12 rating" / "No rating change". The visible chip renders the terse
 * signed figure (`formatRatingDelta`); this spells it out so a reader doesn't
 * announce the "+"/"Δ" glyph as literal punctuation. */
export function formatRatingDeltaAria(delta: number): string {
  const rounded = Math.round(delta)
  if (rounded === 0) return 'No rating change'
  const verb = rounded > 0 ? 'Gained' : 'Lost'
  return `${verb} ${Math.abs(rounded)} rating`
}

/**
 * The three truthful accessible names for a Δ (rating-change) cell that prints
 * an **em dash** instead of a signed figure. The same glyph stands for three
 * different facts, and a screen reader must be told which — otherwise every
 * no-delta row announces identically (or, on the dashboard, not at all).
 */
export const RATING_DELTA_EMPTY_ARIA = {
  /** A decided match that moved no rating — unrated, voided, or a rounded-0. */
  noChange: 'No rating change',
  /** A live / awaiting / up-next match — the rating is not decided yet. */
  undecided: 'Not yet decided',
  /** The player's FIRST rated match: a *present* change whose `delta` is null.
   * It established the rating rather than moving it (#915). */
  established: 'Rating established',
} as const

/**
 * The accessible name for a Δ cell with no signed figure to show, resolved from
 * the two facts that separate its three states:
 *
 * - a *present* rating change with a `null` delta established the rating rather
 *   than moving it → "Rating established";
 * - otherwise, an undecided (still-in-play) match → "Not yet decided";
 * - otherwise, a decided match that moved no rating → "No rating change".
 *
 * A present change with a *numeric* delta never reaches here — that renders the
 * signed figure via `formatRatingDeltaAria` (which itself says "No rating
 * change" for a rounded-0). Shared by the profile recent-match row and the
 * dashboard recent-results card so the two surfaces cannot drift.
 */
export function emptyRatingDeltaAria(
  ratingChange: { delta: number | null } | null | undefined,
  decided: boolean,
): string {
  if (ratingChange != null) return RATING_DELTA_EMPTY_ARIA.established
  return decided
    ? RATING_DELTA_EMPTY_ARIA.noChange
    : RATING_DELTA_EMPTY_ARIA.undecided
}
