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
