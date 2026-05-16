export function formatRatingDelta(delta: number): string {
  const rounded = Math.round(delta)
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded}`
}
