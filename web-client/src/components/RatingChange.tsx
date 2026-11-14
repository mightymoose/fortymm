import './RatingChange.css'

// The design system's rating change (.rating-up, .rating-down): how a match
// moved a rating, in figures, with a sign and an arrow as well as a colour.
// A rise is "▲ +12" in --rating-up; a fall "▼ −8" (a true minus sign) in
// --rating-down. The arrow is decoration; the signed number is read.
export function RatingChange({ change }: { change: number }) {
  const up = change >= 0
  return (
    <span className={up ? 'rating-change rating-change--up' : 'rating-change'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>{' '}
      {up ? `+${change}` : `−${Math.abs(change)}`}
    </span>
  )
}
