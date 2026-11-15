import { useState } from 'react'
import { FilterChip } from './FilterChip.tsx'
import './FilterChips.css'

// A row of filter chips that narrow one list (the design system's
// .fm-chips), as kit.js runs them: several can be on; the first chip,
// `allLabel` ("All events"), is on exactly when no other is, and pressing it
// turns the others off. A group named by `label`. `onChange` hears the values
// that are on after each press (none: everything is shown).
export function FilterChips({
  label,
  allLabel,
  options,
  defaultOn = [],
  onChange,
}: {
  label: string
  allLabel: string
  options: { value: string; label: string }[]
  defaultOn?: string[]
  onChange?: (on: string[]) => void
}) {
  const [on, setOn] = useState(defaultOn)

  function change(next: string[]) {
    setOn(next)
    onChange?.(next)
  }

  function toggle(value: string) {
    change(
      on.includes(value)
        ? on.filter((other) => other !== value)
        : options
            .map((option) => option.value)
            .filter((other) => other === value || on.includes(other)),
    )
  }

  return (
    <div role="group" aria-label={label} className="chips">
      <FilterChip pressed={on.length === 0} onClick={() => change([])}>
        {allLabel}
      </FilterChip>
      {options.map((option) => (
        <FilterChip
          key={option.value}
          pressed={on.includes(option.value)}
          onClick={() => toggle(option.value)}
        >
          {option.label}
        </FilterChip>
      ))}
    </div>
  )
}
