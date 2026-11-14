import type { InputHTMLAttributes, ReactNode } from 'react'
import type { ForcedState } from './forced-state.ts'
import './choice.css'
import './Radio.css'

// A radio button (the design system's .fm-radio): a native radio inside its
// label. Radios with the same `name` are one group: choosing one clears the
// others, and the arrow keys move between them.
export function Radio({
  children,
  forcedState,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className' | 'children'
> & {
  children: ReactNode
  forcedState?: ForcedState
}) {
  return (
    <label className="choice">
      <input
        {...props}
        type="radio"
        className="choice__input radio"
        data-forced-state={forcedState}
      />
      {children}
    </label>
  )
}
