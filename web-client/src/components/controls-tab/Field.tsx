import { useId, type ReactNode } from 'react'
import { Icon } from '../Icon.tsx'
import './Field.css'

// What a field's control needs from its Field: the id its label points at,
// the help or error text that describes it, and whether it is invalid.
export type FieldControlProps = {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

// A form field (the design system's .fm-field): a label, one control, and
// either help text or an error beneath. The control is the child, a function
// given the props that tie it to the label and the text:
//
//   <Field label="Club" optional help="Shown next to your name in draws.">
//     {(control) => <TextInput {...control} placeholder="Search clubs" />}
//   </Field>
//
// An error replaces the help: it marks the control invalid, describes it, and
// says what's wrong and how to fix it. `hideLabel` keeps the label for
// assistive technology only, where the control's purpose shows otherwise.
export function Field({
  label,
  optional = false,
  hideLabel = false,
  help,
  error,
  children,
}: {
  label: string
  optional?: boolean
  hideLabel?: boolean
  help?: string
  error?: string
  children: (control: FieldControlProps) => ReactNode
}) {
  const id = useId()
  const messageId = `${id}-message`
  const message = error ?? help

  return (
    <div className="field">
      <label
        className={hideLabel ? 'visually-hidden' : 'field__label'}
        htmlFor={id}
      >
        {label}
        {optional && (
          <>
            {' '}
            <span className="field__optional">(optional)</span>
          </>
        )}
      </label>
      {children({
        id,
        'aria-describedby': message === undefined ? undefined : messageId,
        'aria-invalid': error === undefined ? undefined : true,
      })}
      {error !== undefined ? (
        <p id={messageId} className="field__error">
          <Icon name="circle-alert" />
          {error}
        </p>
      ) : help !== undefined ? (
        <p id={messageId} className="field__help">
          {help}
        </p>
      ) : null}
    </div>
  )
}
