import type { ComponentProps } from 'react'
import { useFieldControl } from './fieldContext'

// A multi-line text input, styled by `.textarea` in styles/base.css. Inside a
// Field it's wired to the field's label, help text and state.
export function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea className="textarea" {...useFieldControl(props)} />
}
