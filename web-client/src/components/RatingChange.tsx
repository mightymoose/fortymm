// A change in a player's rating, always signed and with its arrow, styled by
// `.rating-up` and `.rating-down` in styles/base.css: "▲ +12" or "▼ −12",
// with a true minus sign. No change is a plain "0".
export function RatingChange({ change }: { change: number }) {
  if (change > 0) return <span className="rating-up">▲ +{change}</span>
  if (change < 0) return <span className="rating-down">▼ −{-change}</span>
  return <span>0</span>
}
