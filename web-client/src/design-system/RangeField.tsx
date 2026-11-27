import { useId, useState } from 'react'

// A number picked from a range: a native range input (fm-range) with its label above, and the
// current value after the label. Native rather than React Aria's useSlider (divs): the board draws
// a native range. The input is named by the label alone and reads its value out as formatValue
// gives it, e.g. "15 min".
export function RangeField({
  label,
  min,
  max,
  step,
  defaultValue,
  formatValue = String,
}: {
  label: string
  min: number
  max: number
  step?: number
  defaultValue: number
  formatValue?: (value: number) => string
}) {
  const id = useId()
  const labelId = useId()
  const [value, setValue] = useState(defaultValue)
  return (
    <div className="fm-field">
      <label className="fm-label" htmlFor={id}>
        <span id={labelId}>{label}</span> ·{' '}
        <output className="num" htmlFor={id}>
          {formatValue(value)}
        </output>
      </label>
      <input
        id={id}
        type="range"
        className="fm-range"
        aria-labelledby={labelId}
        aria-valuetext={formatValue(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setValue(e.target.valueAsNumber)}
      />
    </div>
  )
}
