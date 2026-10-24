import { useState } from 'react'
import { useAnnounce } from './announceContext'

// Chips that narrow a list, styled by `.fm-chips` and `.fm-chip` in
// styles/kit.css, as kit.js runs `data-select="filter"`. Several options can
// be on together. The first chip, `allLabel`, turns them all off, and it's on
// whenever none of them is. Each change calls `onChange` with the labels of
// the chips that are on, and reads them out.
export function FilterChips({
  label,
  allLabel,
  options,
  onChange,
}: {
  label: string
  allLabel: string
  options: readonly string[]
  onChange?: (shown: string[]) => void
}) {
  const [on, setOn] = useState<readonly string[]>([])
  const announce = useAnnounce()

  const change = (next: readonly string[]) => {
    setOn(next)
    const shown = next.length ? [...next] : [allLabel]
    announce(`Showing ${shown.join(', ')}`)
    onChange?.(shown)
  }
  const toggle = (option: string) =>
    change(options.filter((o) => (o === option ? !on.includes(o) : on.includes(o))))

  return (
    <div className="fm-chips" aria-label={label}>
      <button
        type="button"
        className="fm-chip"
        aria-pressed={on.length === 0}
        onClick={() => change([])}
      >
        {allLabel}
      </button>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className="fm-chip"
          aria-pressed={on.includes(option)}
          onClick={() => toggle(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
