import { useId, type ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

import { ReadOnlyValue, type ReadOnlyValueContent } from './read-only-value'

export interface FieldBase {
  label: string
  required?: boolean
  /** Helper or error text shown below the control. */
  hint?: ReactNode
  /** When true, `hint` is rendered as an error (red). */
  error?: boolean
  className?: string
}

/** A row that can be read-only **must** say what it holds. The two props are one
 * decision, so the type makes them one: opt into `readOnly` and `value` is
 * required. Were they independent optionals, a row could pass `readOnly` and
 * forget `value` — and would then render an em-dash, which by ADR 0015 rule 3
 * means *the organizer set nothing*. That is real data misreported as absent,
 * silently: the guard sweep still passes (no control is rendered) and the
 * per-field value assertions don't know the new row exists. Exactly the class of
 * quiet wrongness this ADR was written to end.
 *
 * Note the discriminant is the **presence** of `readOnly`, not its value — call
 * sites pass `readOnly={!canEdit}`, a `boolean`, which no `true`/`false` union
 * could narrow. */
type FieldReadable = {
  readOnly: boolean
  /** What the row *holds* — rendered in place of the control when `readOnly`.
   * Formatted for a reader by the caller (an option's label, a formatted date),
   * since only the caller knows what the raw value means. */
  value: ReadOnlyValueContent
  /** Class for the read-only rendering, when it needs to match the control it
   * stands in for (a `font-mono` time, a multi-line description). */
  valueClassName?: string
  /** The control, for an editor. Not called in the read-only branch — and a row
   * that is *only* ever a view (one inside a subtree the editor never renders,
   * like a read-only reservation card) has no control to give.
   *
   * The second argument is the **hint's id** (`undefined` when the row shows no
   * hint) — see `FieldControl`. */
  children?: FieldControl
}

/** A row that is always an editor (a create form, say) needs no reader's value. */
type FieldEditorOnly = {
  readOnly?: undefined
  value?: undefined
  valueClassName?: undefined
  children: FieldControl
}

/**
 * A row's control, given the ids it must wire itself with:
 *
 * - `controlId` — the id the label's `htmlFor` targets (a real input sets it as `id`;
 *   a non-input control points `aria-labelledby` at `${controlId}-label` instead).
 * - `hintId` — the id of the row's **hint**, or `undefined` when the row is showing
 *   none. A control with a hint must point `aria-describedby` at it: the hint is the
 *   sentence that explains the control (a validation message, or — for the draw type
 *   under a cut draw, ADR-0786 — the reason it is disabled and the way out of it), and
 *   a `<p>` that merely sits *below* a control is next to it on screen and nowhere at
 *   all to a screen reader. A **disabled** control is the case that bites: it is not
 *   focusable, holds no tooltip anyone will hear, and so has literally no other channel
 *   to say why it is dead — which is the unexplained dead end ADR-0015 forbids.
 *
 * It is passed rather than applied because `children` is a render prop returning an
 * opaque `ReactNode`: `Field` cannot reach into it and set an attribute. What `Field`
 * *can* guarantee is that the id it hands out is the id it rendered — and that it hands
 * out `undefined` when there is no hint, so no control can describe itself by an element
 * that isn't there (a dangling `aria-describedby` is an axe violation of its own).
 */
export type FieldControl = (
  controlId: string,
  hintId: string | undefined,
) => ReactNode

export type FieldProps = FieldBase & (FieldReadable | FieldEditorOnly)

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
 * `ToggleGroup`, the reservation table chips — don't come through `Field`; the guard
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
  // Handed to the control ONLY while the hint is really on screen: a control that
  // described itself by an id nothing renders would be pointing at nothing, which is
  // both useless to a screen reader and an `aria-valid-attr-value` violation.
  const hintId = showHint ? `${id}-hint` : undefined
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label
        id={`${id}-label`}
        // Read-only renders no control, so there is no element with this id to
        // point at — a dangling `for` is an orphaned label, not an association.
        htmlFor={readOnly ? undefined : id}
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
        children?.(id, hintId)
      )}
      {showHint && (
        <p
          id={hintId}
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
