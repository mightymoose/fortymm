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
