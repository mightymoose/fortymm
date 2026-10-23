// A change in a player's rating, signed with a plus or a true minus (U+2212,
// not a hyphen) and colored as a gain or a loss.
export function RatingDelta({ value }: { value: number }) {
  if (value > 0) {
    return <span className="rating-delta--gain">+{value}</span>
  }
  if (value < 0) {
    return <span className="rating-delta--loss">−{-value}</span>
  }
  return <span>0</span>
}
