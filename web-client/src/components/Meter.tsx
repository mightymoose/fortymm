// How far along something is, styled by `.fm-meter` in styles/kit.css: a
// progress bar named `label`, `value` of `max`. `rest` colours it as rest
// time, with `.fm-meter--rest`.
export function Meter({
  label,
  value,
  max,
  rest = false,
}: {
  label: string
  value: number
  max: number
  rest?: boolean
}) {
  return (
    <div
      className={rest ? 'fm-meter fm-meter--rest' : 'fm-meter'}
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemax={max}
    >
      {/* A whole percent: the reference draws 7 of 15 as 47%. */}
      <i style={{ width: `${Math.round((value / max) * 100)}%` }}></i>
    </div>
  )
}
