import type { ComponentProps } from 'react'
import { useFieldControl } from './fieldContext'

// An on/off switch with its label: a <label> holding the label text
// (`children`), a real <input type="checkbox" role="switch">, visually
// hidden, and a `.switch-track` after it that draws its state. Styled by
// `.switch` in styles/base.css.
//
// Inside a Field it takes the field's disabled state and is described by its
// FieldHelp. It carries its own label, so the Field needs no Label. A switch
// takes effect as it's flipped, so neither state is an error: it takes no
// `required` or `aria-invalid`, from its props or the Field.
export function Switch({
  className,
  children,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'role' | 'required' | 'aria-invalid'>) {
  return (
    <label className={className ? `switch ${className}` : 'switch'}>
      <span className="switch-text">{children}</span>
      <input
        className="switch-input visually-hidden"
        type="checkbox"
        role="switch"
        {...useFieldControl({
          ...props,
          required: undefined,
          'aria-invalid': undefined,
        })}
      />
      <span className="switch-track" aria-hidden="true" />
    </label>
  )
}
