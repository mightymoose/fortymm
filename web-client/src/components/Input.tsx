import type { ComponentProps } from 'react'
import { useFieldControl } from './fieldContext'

// A text input, styled by `.input` in styles/base.css. Inside a Field it's
// wired to the field's label, help text and state.
export function Input(props: ComponentProps<'input'>) {
  return <input className="input" {...useFieldControl(props)} />
}
