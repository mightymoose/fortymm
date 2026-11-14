import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react'
import type { ForcedState } from './forced-state.ts'
import './choice.css'
import './Checkbox.css'

// A checkbox (the design system's .fm-check): a native checkbox inside its
// label, so clicking the label toggles it and the label names it. Checked or
// not, as any input: `defaultChecked`, or `checked` with `onChange`.
// `indeterminate` shows a dash for "some of these" (a parent of a partly
// chosen list), which assistive technology reads as mixed.
export function Checkbox({
  children,
  indeterminate = false,
  forcedState,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className' | 'children'
> & {
  children: ReactNode
  indeterminate?: boolean
  forcedState?: ForcedState
}) {
  const input = useRef<HTMLInputElement>(null)
  // Only a script can make a checkbox indeterminate; there is no attribute.
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label className="choice">
      <input
        {...props}
        ref={input}
        type="checkbox"
        className="choice__input checkbox"
        data-forced-state={forcedState}
      />
      {children}
    </label>
  )
}
