import { ToggleButton, ToggleButtonGroup } from 'react-aria-components'
import { type Option } from './Option.ts'

// Change how the same data is shown (fm-seg): exactly one option is always on. Use 2–4 short
// options. React Aria's single-selection ToggleButtonGroup: a radio group of buttons.
export function SegmentedControl({
  'aria-label': ariaLabel,
  options,
  defaultSelectedId,
  onChange,
}: {
  'aria-label': string
  options: readonly Option[]
  defaultSelectedId: string
  onChange?: (id: string) => void
}) {
  return (
    <ToggleButtonGroup
      className="fm-seg"
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      defaultSelectedKeys={[defaultSelectedId]}
      onSelectionChange={(keys) => {
        const [id] = keys
        if (id !== undefined) onChange?.(String(id))
      }}
    >
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
