import { useId } from 'react'

// How the value reads beside the label: "12 / 16", or "25%" of max.
export type ProgressFormat = 'fraction' | 'percent'

function formatValue(
  value: number,
  max: number,
  format: ProgressFormat,
): { shown: string; spoken: string } {
  if (format === 'percent') {
    const percent = `${Math.round((value / max) * 100)}%`
    return { shown: percent, spoken: percent }
  }
  return { shown: `${value} / ${max}`, spoken: `${value} of ${max}` }
}

// How far along something is (a round, a group's matches), as a labelled
// bar styled by `.progress` in styles/base.css. The bar carries the value
// for assistive tech, so the value shown beside the label is hidden from it.
export function Progress({
  label,
  value,
  max,
  format,
}: {
  label: string
  value: number
  max: number
  format: ProgressFormat
}) {
  const labelId = useId()
  const { shown, spoken } = formatValue(value, max, format)
  return (
    <div>
      <div className="row progress-header">
        <span id={labelId}>{label}</span>
        <span className="progress-value" aria-hidden="true">
          {shown}
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={spoken}
      >
        <div
          className="progress-bar"
          style={{ width: `${(value / max) * 100}%` }}
        />
      </div>
    </div>
  )
}
