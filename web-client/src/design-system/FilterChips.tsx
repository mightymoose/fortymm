import { useState } from 'react'
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components'
import { type Option } from './Option.ts'

// The key of the chip that stands for no filter. Not an option id: those come from callers.
const all = '\u0000all'

// Narrow a list (fm-chips): several options can be on together. The first chip (allLabel, e.g.
// "All events") clears them, and switches back on when none are left. React Aria's
// multiple-selection ToggleButtonGroup: a toolbar of buttons that are pressed or not.
export function FilterChips({
  'aria-label': ariaLabel,
  allLabel,
  options,
  defaultSelectedIds = [],
  onChange,
}: {
  'aria-label': string
  allLabel: string
  options: readonly Option[]
  defaultSelectedIds?: readonly string[]
  onChange?: (ids: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([...defaultSelectedIds])
  return (
    <ToggleButtonGroup
      className="fm-chips"
      aria-label={ariaLabel}
      selectionMode="multiple"
      selectedKeys={selected.length ? selected : [all]}
      onSelectionChange={(keys) => {
        const ids = keys.has(all) && selected.length ? [] : [...keys].map(String).filter((k) => k !== all)
        // Keep the options' order, whatever order they were switched on in.
        const next = options.map((o) => o.id).filter((id) => ids.includes(id))
        setSelected(next)
        onChange?.(next)
      }}
    >
      <ToggleButton id={all} className="fm-chip">
        {allLabel}
      </ToggleButton>
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id} className="fm-chip">
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
