import type { TextareaHTMLAttributes } from 'react'
import type { ForcedState } from './forced-state.ts'
import './field-control.css'
import './TextArea.css'

// A text area (the design system's .fm-textarea): several lines, resized
// vertically. Name it like a TextInput.
export function TextArea({
  forcedState,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  forcedState?: ForcedState
}) {
  return (
    <textarea
      {...props}
      className="field-control text-area"
      data-forced-state={forcedState}
    />
  )
}
