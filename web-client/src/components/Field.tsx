import {
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { FieldContext, useField } from './fieldContext'

// A form field: a label, one control and optional help text, in a
// `.form-field` wrapper (styles/base.css). The parts read the field's ids and
// state from context, and controls pick them up with useFieldControl.
export function Field({
  invalid = false,
  required = false,
  disabled = false,
  children,
}: {
  invalid?: boolean
  required?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  const id = useId()
  const [hasHelp, setHasHelp] = useState(false)
  const field = useMemo(
    () => ({
      controlId: `${id}-control`,
      helpId: `${id}-help`,
      hasHelp,
      setHasHelp,
      invalid,
      required,
      disabled,
    }),
    [id, hasHelp, invalid, required, disabled],
  )
  return (
    <FieldContext.Provider value={field}>
      <div className="form-field">{children}</div>
    </FieldContext.Provider>
  )
}

// The field's label, for its control. A required field's label gets an
// asterisk, hidden from assistive tech since the control itself is required.
export function Label({ className, children, ...props }: ComponentProps<'label'>) {
  const field = useField()
  return (
    <label
      htmlFor={field?.controlId}
      className={className ? `field-label ${className}` : 'field-label'}
      {...props}
    >
      {children}
      {field?.required && (
        <>
          {' '}
          <span className="req" aria-hidden="true">
            *
          </span>
        </>
      )}
    </label>
  )
}

// Help text under the control, which describes it. It reads as an error when
// the field is invalid.
export function FieldHelp({ className, ...props }: ComponentProps<'div'>) {
  const field = useField()
  const setHasHelp = field?.setHasHelp
  useLayoutEffect(() => {
    if (!setHasHelp) return
    setHasHelp(true)
    return () => setHasHelp(false)
  }, [setHasHelp])
  const classes = ['field-help']
  if (field?.invalid) classes.push('field-help--error')
  if (className) classes.push(className)
  return <div id={field?.helpId} className={classes.join(' ')} {...props} />
}
