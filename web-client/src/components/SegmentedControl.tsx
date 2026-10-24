import { useSingleSelect } from './singleSelect'

// A choice of how to show the same data, styled by `.fm-seg` in
// styles/kit.css: a radiogroup of 2 to 4 short options, of which exactly one
// is always on, the first to start with. Only that option is a tab stop, and
// the arrow keys, Home and End turn on another. `onChange` gets the option
// turned on.
export function SegmentedControl({
  label,
  options,
  onChange,
}: {
  label: string
  options: readonly string[]
  onChange?: (option: string) => void
}) {
  const { optionProps } = useSingleSelect('radio', options, onChange)
  return (
    <div className="fm-seg" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button key={option} type="button" role="radio" {...optionProps(index)}>
          {option}
        </button>
      ))}
    </div>
  )
}
