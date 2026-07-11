import { useId, type ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

import { ReadOnlyValue, type ReadOnlyValueContent } from './read-only-value'

export interface FieldProps {
  label: string
  required?: boolean
  /** Helper or error text shown below the control. */
  hint?: ReactNode
  /** When true, `hint` is rendered as an error (red). */
  error?: boolean
  /** When true the row renders its `value` instead of its control, and drops the
   * form's furniture (the `hint` and the `required` asterisk). See below. */
  readOnly?: boolean
  /** What the row *holds* — rendered in place of the control when `readOnly`.
   * Formatted for a reader by the caller (an option's label, a formatted date),
   * since only the caller knows what the raw value means. */
  value?: ReadOnlyValueContent
  /** Class for the read-only rendering, when it needs to match the control it
   * stands in for (a `font-mono` time, a multi-line description). */
  valueClassName?: string
  /** The control, for an editor. Not called in the read-only branch — a row that
   * is only ever a view may omit it. */
  children?: (controlId: string) => ReactNode
  className?: string
}

/** Uppercase-overline label + control + hint, the standard form row used
 * across the tournament forms. `children` receives the generated control id:
 * a real input wires it as `id` (the label's `htmlFor` targets it); a
 * non-input control (e.g. a radio `ToggleGroup`) instead points
 * `aria-labelledby` at the label's `${id}-label` id.
 *
 * **`readOnly` makes the row a view, and `Field` owns that branch** (ADR 0015).
 * The caller passes `readOnly` and a `value`; the row decides for itself whether
 * to render the control or the value, and drops the form's furniture with it —
 * a **hint** explains how to fill in a control, and with no control there is
 * nothing to explain; a **required asterisk** marks a field you must complete,
 * which is nonsense on a field nobody can fill in. Both are dropped, not
 * reworded, and callers keep declaring them unconditionally.
 *
 * One flag, one obligation. A `canEdit ? <Input/> : <ReadOnlyValue/>` at every
 * call site would be a second one — and "twenty `disabled` props are twenty
 * chances to forget one" is just as true of a dozen `readOnly` branches. Here the
 * leak is structurally impossible rather than merely tested for:
 *
 * ```tsx
 * <Field label="Entry fee" readOnly={!canEdit} value={event.entryFee}>
 *   {(id) => <Input id={id} type="number" … />}
 * </Field>
 * ```
 *
 * (Controls that aren't a "label + one control + one value" row — a `Switch`, a
 * `ToggleGroup`, the pool table chips — don't come through `Field`; the guard
 * test in rule 6 is what covers those.) */
export const Field = ({
  label,
  required,
  hint,
  error,
  readOnly,
  value,
  valueClassName,
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
      {readOnly ? (
        <ReadOnlyValue className={valueClassName}>{value}</ReadOnlyValue>
      ) : (
        children?.(id)
      )}
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
