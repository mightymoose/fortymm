// How far along something is, styled by `.fm-meter` in styles/kit.css: a
// progress bar named `label`, `value` of `max`. `percent` sets how much of
// it is filled, where a page rounds it, and is `value` of `max` exactly
// otherwise. `rest` colours it as rest time, with `.fm-meter--rest`.
export function Meter({
  label,
  value,
  max,
  percent = (value / max) * 100,
  rest = false,
}: {
  label: string
  value: number
  max: number
  percent?: number
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
      <i style={{ width: `${percent}%` }}></i>
    </div>
  )
}
