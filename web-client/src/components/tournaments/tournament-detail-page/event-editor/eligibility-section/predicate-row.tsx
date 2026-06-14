import { Trash2 } from 'lucide-react'

import { Input } from '@/components/ui/input'

import {
  PRED_FIELDS,
  PRED_OPS_BY_TYPE,
} from '../../../data/options'
import type { Predicate, PredicateValue } from '../../../data/types'
import { OptionSelect } from '../option-select'

export interface PredicateRowProps {
  predicate: Predicate
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

/** One ANDed eligibility rule: a field picker, an operator picker, a
 * type-appropriate value control, and a remove button. Switching the field
 * resets the operator and value to that field-type's defaults. */
export const PredicateRow = ({
  predicate,
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
            a club member
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
