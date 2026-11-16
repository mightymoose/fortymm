import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { ForcedState } from '../forced-state.ts'
import './Switch.css'

// A switch (the design system's .fm-switch): a setting that applies at once,
// never a filter. A button with role="switch", named by its text, that turns
// on and off when pressed (click, Space or Enter). On or off from
// `defaultChecked`, or set by `checked`; `onCheckedChange` hears each press.
export function Switch({
  children,
  checked,
  defaultChecked = false,
  onCheckedChange,
  forcedState,
  ...props
}: Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'role' | 'className' | 'children' | 'onClick' | 'aria-checked'
> & {
  children: ReactNode
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  forcedState?: ForcedState
}) {
  const [own, setOwn] = useState(defaultChecked)
  const on = checked ?? own

  function press() {
    setOwn(!on)
    onCheckedChange?.(!on)
  }

  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={on}
      className="switch"
      data-forced-state={forcedState}
      onClick={press}
    >
      <span className="switch__track" />
      {children}
    </button>
  )
}
