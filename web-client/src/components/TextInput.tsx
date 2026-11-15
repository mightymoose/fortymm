import type { ComponentPropsWithRef } from 'react'
import type { ForcedState } from './forced-state.ts'
import './field-control.css'
import './TextInput.css'

// A one-line text input (the design system's .fm-input). Name it with a
// <label>, best through a Field, or with aria-label where no label shows.
// `numeric` sets numbers in the number font, with tabular figures. A `ref`
// reaches the <input> (a form library registers it, to focus it).
export function TextInput({
  numeric = false,
  forcedState,
  type = 'text',
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'className'> & {
  numeric?: boolean
  forcedState?: ForcedState
}) {
  return (
    <input
      {...props}
      type={type}
      className={
        numeric
          ? 'field-control text-input text-input--numeric'
          : 'field-control text-input'
      }
      data-forced-state={forcedState}
    />
  )
}
