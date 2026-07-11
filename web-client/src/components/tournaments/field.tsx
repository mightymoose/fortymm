import { useId, type ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface FieldProps {
  label: string
  required?: boolean
  /** Helper or error text shown below the control. */
  hint?: ReactNode
  /** When true, `hint` is rendered as an error (red). */
  error?: boolean
  /** When true the row wraps a *value* rather than a control (the caller has
   * rendered a `ReadOnlyValue` instead of an input), so the form's furniture —
   * the `hint` and the `required` asterisk — is suppressed. See below. */
  readOnly?: boolean
  children: (controlId: string) => ReactNode
  className?: string
}

/** Uppercase-overline label + control + hint, the standard form row used
 * across the tournament forms. `children` receives the generated control id:
 * a real input wires it as `id` (the label's `htmlFor` targets it); a
 * non-input control (e.g. a radio `ToggleGroup`) instead points
 * `aria-labelledby` at the label's `${id}-label` id.
 *
 * `readOnly` drops the row's form furniture (ADR 0015): a **hint** explains how
 * to fill in a control, and with no control there is nothing to explain; a
 * **required asterisk** marks a field you must complete, which is nonsense on a
 * field nobody can fill in. Both are dropped, not reworded. Callers keep passing
 * `hint` / `required` unconditionally — the suppression lives here, so a newly
 * added field cannot reintroduce them by forgetting a call-site conditional. */
export const Field = ({
  label,
  required,
  hint,
  error,
  readOnly,
  children,
  className,
}: FieldProps) => {
  const id = useId()
  const showHint = hint && !readOnly
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label
        id={`${id}-label`}
        htmlFor={id}
        className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
      >
        {label}
        {required && !readOnly && (
          <span className="text-[color:var(--ball-500)]">*</span>
        )}
      </Label>
      {children(id)}
      {showHint && (
        <p
          className={cn(
            'text-[11px]',
            error ? 'text-[color:var(--loss)]' : 'text-[color:var(--fg-3)]',
          )}
        >
          {hint}
        </p>
      )}
    </div>
  )
}
