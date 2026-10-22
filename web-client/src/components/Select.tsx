import type { ComponentProps } from 'react'
import { useFieldControl } from './fieldContext'

// A real native <select>, with its <option>s as `children`, styled by
// `.select` in styles/base.css.
//
// Inside a Field it's wired to the field's label, help text and every state,
// as a text input is. Unlike a switch or a slider, a select can be left on an
// empty placeholder option, so required and invalid mean something for it.
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={className ? `select ${className}` : 'select'}
      {...useFieldControl(props)}
    />
  )
}
