import { Trash2 } from 'lucide-react'

import { Input } from '@/components/ui/input'

import { predicateSentence } from '../../../data/helpers'
import {
  PRED_FIELDS,
  PRED_OPS_BY_TYPE,
  parsePredicateOp,
} from '../../../data/options'
import { RATING_MAX, RATING_MIN } from '../../../data/predicate-validation'
import type { PredicateIssues } from '../../../data/predicate-validation'
import type { Predicate } from '../../../data/types'
import { OptionSelect } from '../option-select'

export interface PredicateRowProps {
  predicate: Predicate
  /** When false (a non-creator), the row renders as one readable sentence
   * instead of three controls — a viewer gets a rendering of the data, never a
   * disabled form (ADR 0015). The sentence itself is `predicateSentence` in
   * `data/helpers.ts`, beside the chip formatter it shares its vocabulary with:
   * a new predicate field or operator is a one-file change there, not a hunt
   * through this component. */
  canEdit: boolean
  /** What is wrong with this rule, per control (`predicateIssues`,
   * `data/predicate-validation.ts`) — or `undefined` while the editor is not yet
   * showing errors. The row does not *decide* this: the editor validates the whole
   * draft on submit and hands each row its share, so "may I save?" and "what does
   * this row say in red?" are one answer, computed once. */
  issues?: PredicateIssues
  onChange: (predicate: Predicate) => void
  onRemove: () => void
}

/** A field error, in the house style: red, small, directly beneath its control
 * (web-client `CLAUDE.md`, `## Forms` — never a toast for a field). */
const FieldError = ({ children }: { children: string }) => (
  <p
    data-testid="predicate-error"
    className="mt-1.5 text-xs text-[color:var(--loss)]"
  >
    {children}
  </p>
)

const FIELD_OPTIONS = Object.entries(PRED_FIELDS).map(([value, schema]) => ({
  value,
  label: schema.label,
}))

function numberOrNull(raw: string): number | null {
  if (raw === '') return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

/** One ANDed eligibility rule. For the creator: a field picker, an operator
 * picker, a value control, and a remove button — switching the field resets the
 * operator and clears the value, so a rule is never left holding the previous
 * field's answer. For a viewer: the same rule, read back as a sentence.
 *
 * The field picker offers exactly one field today — `Rating`, the only fact we
 * hold about a player that a rule can be evaluated against (ADR-0783). It stays a
 * picker rather than collapsing into a caption because the vocabulary is a list
 * that grows (`PRED_FIELDS`), and a one-item list is still that list. */
export const PredicateRow = ({
  predicate,
  canEdit,
  issues,
  onChange,
  onRemove,
}: PredicateRowProps) => {
  const schema = PRED_FIELDS[predicate.field]
  const ops = schema ? PRED_OPS_BY_TYPE[schema.type] : []

  const setField = (field: string) => {
    const next = PRED_FIELDS[field]
    if (!next) return
    onChange({
      ...predicate,
      field: field as Predicate['field'],
      op: PRED_OPS_BY_TYPE[next.type][0].value,
      value: null,
    })
  }

  /** `OptionSelect` hands back the raw `string` the listbox emitted; a
   * `Predicate` holds a `PredicateOp`. `parsePredicateOp` (`data/options.ts`)
   * narrows the one to the other against the very table these options were
   * rendered from — so an operator the builder never offered cannot enter a
   * rule, and no cast is needed to say so. */
  const setOp = (raw: string) => {
    const op = schema ? parsePredicateOp(schema.type, raw) : null
    if (op === null) return
    onChange({ ...predicate, op })
  }

  const between = Array.isArray(predicate.value)
    ? predicate.value
    : [null, null]

  // The distinct complaints about the two bounds, in bound order. Deduped: both
  // boxes empty is ONE thing to say, not the same sentence printed twice.
  const boundMessages = [...new Set([issues?.lower, issues?.upper])].filter(
    (message): message is string => message !== undefined,
  )

  if (!canEdit) {
    return (
      <p
        data-testid="predicate-row"
        className="rounded-[6px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)] px-3.5 py-2.5 text-[13px] text-[color:var(--fg-1)]"
      >
        {predicateSentence(predicate)}
      </p>
    )
  }

  return (
    // **Stacked below `sm`, four columns above it** — the same breakpoint the sheet
    // itself switches on (`w-full sm:w-[820px]`), so the row's layout changes exactly
    // when the space it has does.
    //
    // The fixed `160px 180px` prefix is 340px of a 375px phone before the Value input
    // starts, which put that input — and the Remove button, and (once the rules were
    // validated) the RED MESSAGE UNDER IT — off the right-hand edge of the screen. The
    // form then refused to save and showed the reason to nobody: an error you cannot
    // see is a dead button. A `1fr` column cannot rescue a 340px prefix; the prefix
    // has to stop being one.
    <div
      data-testid="predicate-row"
      className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[160px_180px_1fr_auto]"
    >
      <OptionSelect
        ariaLabel="Field"
        value={predicate.field}
        options={FIELD_OPTIONS}
        onChange={setField}
      />
      <OptionSelect
        ariaLabel="Operator"
        value={predicate.op}
        options={ops}
        onChange={setOp}
      />

      <div>
        {schema?.type === 'number' && predicate.op === 'between' && (
          <>
            {/* Two number boxes and the word between them: side by side where there
                is room, stacked where there is not. Two 160px inputs plus "and" do
                not fit a phone's column either. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="number"
                aria-label="Lower bound"
                min={RATING_MIN}
                max={RATING_MAX}
                aria-invalid={!!issues?.lower}
                value={between[0] ?? ''}
                onChange={(e) =>
                  onChange({
                    ...predicate,
                    value: [numberOrNull(e.target.value), between[1]],
                  })
                }
              />
              <span className="text-[13px] text-[color:var(--fg-3)]">and</span>
              <Input
                type="number"
                aria-label="Upper bound"
                min={RATING_MIN}
                max={RATING_MAX}
                aria-invalid={!!issues?.upper}
                value={between[1] ?? ''}
                onChange={(e) =>
                  onChange({
                    ...predicate,
                    value: [between[0], numberOrNull(e.target.value)],
                  })
                }
              />
            </div>
            {/* Two controls, but often one complaint ("Enter a rating." under both
                empty boxes says the same thing twice), so the messages are deduped
                and stacked under the pair. */}
            {boundMessages.map((message) => (
              <FieldError key={message}>{message}</FieldError>
            ))}
          </>
        )}
        {schema?.type === 'number' && predicate.op !== 'between' && (
          <>
            <Input
              type="number"
              aria-label="Value"
              placeholder={schema.placeholder}
              min={RATING_MIN}
              max={RATING_MAX}
              aria-invalid={!!issues?.value}
              value={typeof predicate.value === 'number' ? predicate.value : ''}
              onChange={(e) =>
                onChange({ ...predicate, value: numberOrNull(e.target.value) })
              }
            />
            {issues?.value && <FieldError>{issues.value}</FieldError>}
          </>
        )}
      </div>

      {/* Stacked, it is the last thing in the row rather than the last thing in the
          line — pinned to the right edge, where a thumb finds it, and on screen either
          way. (It was off it: a control hidden past the viewport is not a control.) */}
      <button
        type="button"
        aria-label="Remove rule"
        onClick={onRemove}
        className="grid size-9 place-items-center justify-self-end rounded-md border border-transparent text-[color:var(--loss)] hover:bg-[color:rgba(255,77,109,0.16)] sm:justify-self-auto"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}
