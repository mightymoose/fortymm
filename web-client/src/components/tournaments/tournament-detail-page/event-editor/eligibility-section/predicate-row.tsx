import { Trash2 } from 'lucide-react'

import { Input } from '@/components/ui/input'

import {
  PRED_FIELDS,
  PRED_OPS_BY_TYPE,
  type PredicateFieldSchema,
} from '../../../data/options'
import type { Predicate, PredicateValue } from '../../../data/types'
import { OptionSelect } from '../option-select'

export interface PredicateRowProps {
  predicate: Predicate
  /** When false (a non-creator), the row renders as one readable sentence
   * instead of three controls — a viewer gets a rendering of the data, never a
   * disabled form (ADR 0015). */
  canEdit: boolean
  onChange: (predicate: Predicate) => void
  onRemove: () => void
}

const FIELD_OPTIONS = Object.entries(PRED_FIELDS).map(([value, schema]) => ({
  value,
  label: schema.label,
}))

/** The bool field's value, as prose. It reads as the tail of its operator
 * ("must be" + "a club member"), which is why the editor's value cell shows it
 * verbatim rather than a control. */
const BOOL_VALUE = 'a club member'

/** An unset value — the organizer left this bound empty (cf. `ReadOnlyValue`). */
const EM_DASH = '—'

function numberOrNull(raw: string): number | null {
  if (raw === '') return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? EM_DASH : String(n)

const opLabel = (schema: PredicateFieldSchema, op: string): string =>
  PRED_OPS_BY_TYPE[schema.type].find((o) => o.value === op)?.label ?? op

/** The value half of the sentence, in the same words the editor's value control
 * shows: an enum reads as its option label ("Female"), never the stored key. */
function valueText(schema: PredicateFieldSchema, p: Predicate): string {
  if (schema.type === 'enum') {
    const options = schema.options ?? []
    return (
      options.find((o) => o.value === p.value)?.label ??
      (p.value == null ? EM_DASH : String(p.value))
    )
  }
  if (p.op === 'between') {
    const [lo, hi] = Array.isArray(p.value) ? p.value : [null, null]
    return `${num(lo)} and ${num(hi)}`
  }
  return num(typeof p.value === 'number' ? p.value : null)
}

/** The rule as one sentence: `[field] [operator] [value]` was always a sentence
 * chopped into a grid, so read-only it is simply put back together — "USATT
 * rating is between 1200 and 1500" (ADR 0015, rule 4). Every word comes from the
 * labels the editor's own three controls display, so there is no second
 * vocabulary to keep in step.
 *
 * The bool field is the exception: it is the *object* of its operator, so the
 * literal three-cell join would read "Club member must be a club member". It
 * keeps the operator and the prose value only — "Must be a club member". */
function predicateSentence(p: Predicate): string {
  const schema = PRED_FIELDS[p.field]
  if (!schema) return EM_DASH

  const op = opLabel(schema, p.op)
  if (schema.type === 'bool') {
    return `${op.charAt(0).toUpperCase()}${op.slice(1)} ${BOOL_VALUE}`
  }
  return `${schema.label} ${op} ${valueText(schema, p)}`
}

/** One ANDed eligibility rule. For the creator: a field picker, an operator
 * picker, a type-appropriate value control, and a remove button — switching the
 * field resets the operator and value to that field-type's defaults. For a
 * viewer: the same rule, read back as a sentence. */
export const PredicateRow = ({
  predicate,
  canEdit,
  onChange,
  onRemove,
}: PredicateRowProps) => {
  const schema = PRED_FIELDS[predicate.field]
  const ops = schema ? PRED_OPS_BY_TYPE[schema.type] : []

  const setField = (field: string) => {
    const next = PRED_FIELDS[field]
    const value: PredicateValue =
      next.type === 'enum'
        ? (next.options?.[0]?.value ?? null)
        : next.type === 'bool'
          ? true
          : null
    onChange({
      ...predicate,
      field: field as Predicate['field'],
      op: PRED_OPS_BY_TYPE[next.type][0].value,
      value,
    })
  }

  const between = Array.isArray(predicate.value)
    ? predicate.value
    : [null, null]

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
    <div
      data-testid="predicate-row"
      className="grid grid-cols-[160px_180px_1fr_auto] items-start gap-2"
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
        onChange={(op) => onChange({ ...predicate, op })}
      />

      <div>
        {schema?.type === 'number' && predicate.op === 'between' && (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              aria-label="Lower bound"
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
              value={between[1] ?? ''}
              onChange={(e) =>
                onChange({
                  ...predicate,
                  value: [between[0], numberOrNull(e.target.value)],
                })
              }
            />
          </div>
        )}
        {schema?.type === 'number' && predicate.op !== 'between' && (
          <Input
            type="number"
            aria-label="Value"
            placeholder={schema.placeholder}
            value={typeof predicate.value === 'number' ? predicate.value : ''}
            onChange={(e) =>
              onChange({ ...predicate, value: numberOrNull(e.target.value) })
            }
          />
        )}
        {schema?.type === 'enum' && (
          <OptionSelect
            ariaLabel="Value"
            value={String(predicate.value)}
            options={schema.options ?? []}
            onChange={(value) => onChange({ ...predicate, value })}
          />
        )}
        {schema?.type === 'bool' && (
          <div className="py-2.5 text-[13px] text-[color:var(--fg-3)]">
            {BOOL_VALUE}
          </div>
        )}
      </div>

      <button
        type="button"
        aria-label="Remove rule"
        onClick={onRemove}
        className="grid size-9 place-items-center rounded-md border border-transparent text-[color:var(--loss)] hover:bg-[color:rgba(255,77,109,0.16)]"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}
