import type { SelectHTMLAttributes } from 'react'
import type { ForcedState } from '../forced-state.ts'
import '../field-control.css'
import './Select.css'

// A native select (the design system's .fm-select), with the field's edge and
// a drawn chevron. Name it like a TextInput; the options are its children.
export function Select({
  forcedState,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  forcedState?: ForcedState
}) {
  return (
    <select
      {...props}
      className="field-control select"
      data-forced-state={forcedState}
    />
  )
}
