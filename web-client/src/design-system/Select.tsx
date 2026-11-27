import { useId } from 'react'

// A pick-one-of-a-list field: a native select (fm-select) with its label above. Native rather than
// React Aria's Select (a button and a popover): the board draws a native select, and on a phone at
// the table the platform's own picker is the easier one to use.
export function Select({
  label,
  options,
  defaultValue,
}: {
  label: string
  options: readonly string[]
  defaultValue?: string
}) {
  const id = useId()
  return (
    <div className="fm-field">
      <label className="fm-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="fm-select" defaultValue={defaultValue}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </div>
  )
}
