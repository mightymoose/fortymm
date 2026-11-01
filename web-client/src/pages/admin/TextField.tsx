import { useId, type ComponentProps } from 'react'
import type { UseFormRegisterReturn } from 'react-hook-form'
import { FieldError } from '../../components/FieldError'

// A labelled text field of a react-hook-form form, styled by `.fm-field` in
// styles/kit.css: the label, the input, then its help and its error. The
// error marks the input invalid and describes it.
export function TextField({
  label,
  help,
  error,
  optional = false,
  multiline = false,
  registration,
  ...props
}: Omit<ComponentProps<'input'>, keyof UseFormRegisterReturn> & {
  label: string
  help?: string
  error?: string
  optional?: boolean
  multiline?: boolean
  registration: UseFormRegisterReturn
}) {
  const id = useId()
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const describedBy = [help && helpId, error && errorId].filter(Boolean).join(' ')
  const field = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    ...registration,
  }
  return (
    <div className="fm-field">
      <label className="fm-label" htmlFor={id}>
        {label}
        {optional && <span className="opt"> (optional)</span>}
      </label>
      {multiline ? (
        <textarea className="fm-textarea" rows={3} {...field} />
      ) : (
        <input className="fm-input" {...props} {...field} />
      )}
      {help && (
        <p className="fm-help" id={helpId}>
          {help}
        </p>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
}
