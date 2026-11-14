import type { ForcedState } from './forced-state.ts'
import { useSingleSelection } from './single-selection.ts'
import './SegmentedControl.css'

export type Segment = {
  value: string
  label: string
  disabled?: boolean
  forcedState?: ForcedState
}

// A segmented control (the design system's .fm-seg): another view of the
// same data, with one view always on. A radiogroup named by `label`, one
// radio per option; choosing one turns the others off, and choosing the one
// that is on keeps it on. The arrow keys move between options and choose
// them (single-selection.ts). `onChange` hears each new choice.
export function SegmentedControl({
  label,
  options,
  defaultValue,
  onChange,
}: {
  label: string
  options: Segment[]
  defaultValue?: string
  onChange?: (value: string) => void
}) {
  const { selected, optionProps } = useSingleSelection({
    options,
    defaultValue,
    onChange,
  })

  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          {...optionProps(option)}
          type="button"
          role="radio"
          aria-checked={option.value === selected}
          className="segmented__option"
          data-forced-state={option.forcedState}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
