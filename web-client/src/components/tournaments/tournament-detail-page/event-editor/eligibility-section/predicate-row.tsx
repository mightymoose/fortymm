import { Trash2 } from 'lucide-react'

import { Input } from '@/components/ui/input'

import { predicateSentence } from '../../../data/helpers'
import {
  PRED_FIELDS,
  PRED_OPS_BY_TYPE,
  parsePredicateOp,
} from '../../../data/options'
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
  onChange: (predicate: Predicate) => void
  onRemove: () => void
}

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
        onChange={setOp}
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
