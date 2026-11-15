import type { ButtonHTMLAttributes } from 'react'
import type { ForcedState } from '../forced-state.ts'
import './FilterChip.css'

// A filter chip (the design system's .fm-chip): a toggle button that narrows
// a list. `pressed` is whether its filter is on; when it is, the chip shows a
// check (not only colour). Several chips are usually a FilterChips group,
// which keeps their state.
export function FilterChip({
  pressed,
  forcedState,
  ...props
}: Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'className' | 'aria-pressed'
> & {
  pressed: boolean
  forcedState?: ForcedState
}) {
  return (
    <button
      {...props}
      type="button"
      aria-pressed={pressed}
      className="chip"
      data-forced-state={forcedState}
    />
  )
}
