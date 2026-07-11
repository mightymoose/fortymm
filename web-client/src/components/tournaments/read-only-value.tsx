import { cn } from '@/lib/utils'

/** Anything a form control would hold. `null`/`undefined` mean "the organizer
 * left this empty" — they are values, not a missing prop. */
export type ReadOnlyValueContent = string | number | boolean | null | undefined

export interface ReadOnlyValueProps {
  children: ReadOnlyValueContent
  className?: string
}

/** Shown when the value is unset — absent and not-applicable must stay
 * distinguishable, so an empty field renders as an em-dash rather than as
 * nothing at all (ADR 0015). */
const EM_DASH = '—'

/** A value is unset when it is `null`, `undefined`, or a string with nothing in
 * it but whitespace. Note what is *not* unset: `0` and `false` are values the
 * organizer chose, and render as themselves — the reason this is a ladder and
 * not a falsy check. */
const isUnset = (value: ReadOnlyValueContent): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.trim() === '')

/** The read-only counterpart to `Field`'s control slot: renders the value as
 * plain text, at the same height and type scale as the `Input` it replaces, so
 * a viewer's form rows line up with an editor's.
 *
 * Nothing focusable and no form element goes in the accessibility tree — a
 * viewer gets a rendering of the data, never a disabled editor (ADR 0015).
 *
 * ```tsx
 * <Field label="Entry fee">
 *   {() => <ReadOnlyValue>{draft.entryFee}</ReadOnlyValue>}
 * </Field>
 * ```
 *
 * Booleans render as `"true"` / `"false"`; a surface that wants "Yes" / "No"
 * (or any other copy) formats the value before passing it in. What the
 * primitive guarantees is that `false` is never mistaken for empty. */
export const ReadOnlyValue = ({ children, className }: ReadOnlyValueProps) => (
  <p
    data-testid="tournament-read-only-value"
    className={cn(
      'flex h-10 items-center text-sm text-[color:var(--fg-1)]',
      isUnset(children) && 'text-[color:var(--fg-muted)]',
      className,
    )}
  >
    {isUnset(children) ? EM_DASH : String(children)}
  </p>
)
