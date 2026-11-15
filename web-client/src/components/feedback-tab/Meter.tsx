import './Meter.css'

// The design system's meter (.fm-meter): how far along something is (the
// matches played, a rest), as a bar. `value` is a percentage; `label` says
// it in words ("62% of matches played"), since the bar alone can't: it is
// an image with that name. Rest bars are in --rest.
export function Meter({
  value,
  label,
  rest = false,
}: {
  value: number
  label: string
  rest?: boolean
}) {
  return (
    <div
      className={rest ? 'meter meter--rest' : 'meter'}
      role="img"
      aria-label={label}
    >
      <i style={{ width: `${value}%` }} />
    </div>
  )
}
