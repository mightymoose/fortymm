import { Input } from '@/components/ui/input'

import { DRAW_TYPE_OPTIONS, FORMAT_OPTIONS } from '../../data/options'
import type { DrawType, EventFormat, TournamentEvent } from '../../data/types'
import { Field } from '../../field'
import { ReadOnlyValue } from '../../read-only-value'
import { SectionHeader } from '../section-header'
import { OptionSelect } from './option-select'

export interface BasicsSectionProps {
  event: TournamentEvent
  /** When false (a non-creator), the section renders values instead of
   * controls — a viewer gets a rendering of the data, never a disabled form
   * (ADR 0015). */
  canEdit: boolean
  onChange: (next: TournamentEvent) => void
}

/** The numeric fields are edited through `Number(e.target.value)`, so clearing
 * one leaves `NaN` on the draft. To a reader that is an *unset* field — an
 * em-dash — not the literal string "NaN" (what `ReadOnlyValue` would print) and
 * not `0` (a real, different answer: free to enter). */
const numericValue = (n: number): number | null => (Number.isNaN(n) ? null : n)

/** A viewer reads the option's label ("RR → KO"), never the enum key it is
 * stored under ("rr-then-ko"). */
const optionLabel = (
  options: { value: string; label: string }[],
  value: string,
): string | null => options.find((o) => o.value === value)?.label ?? null

/** The event editor's "Basics" tab: name, format, draw type, caps, and the
 * time-slot window. For a non-creator each control is replaced by its value —
 * the `Field` label rows are identical either way, so the two renderings line
 * up (ADR 0015).
 *
 * `readOnly={!canEdit}` on every `Field` is what drops the form's furniture (the
 * required asterisks and the "Hard cap…" hint): the rows still declare `required`
 * and `hint` unconditionally, and `Field` suppresses them for a viewer. */
export const BasicsSection = ({
  event,
  canEdit,
  onChange,
}: BasicsSectionProps) => {
  const set = (patch: Partial<TournamentEvent>) => onChange({ ...event, ...patch })
  const setSlot = (patch: Partial<TournamentEvent['slot']>) =>
    set({ slot: { ...event.slot, ...patch } })
  const readOnly = !canEdit

  return (
    <div className="flex flex-col gap-5" data-testid="basics-section">
      <SectionHeader
        title="The basics"
        subtitle={
          canEdit
            ? 'Name it, decide the format, set the window.'
            : 'Format, entry and schedule.'
        }
      />

      <Field label="Event name" required readOnly={readOnly}>
        {(id) =>
          canEdit ? (
            <Input
              id={id}
              autoFocus
              value={event.name}
              placeholder="Open Singles"
              onChange={(e) => set({ name: e.target.value })}
            />
          ) : (
            <ReadOnlyValue>{event.name}</ReadOnlyValue>
          )
        }
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Format" required readOnly={readOnly}>
          {() =>
            canEdit ? (
              <OptionSelect
                ariaLabel="Format"
                value={event.format}
                options={FORMAT_OPTIONS}
                onChange={(v) => set({ format: v as EventFormat })}
              />
            ) : (
              <ReadOnlyValue>
                {optionLabel(FORMAT_OPTIONS, event.format)}
              </ReadOnlyValue>
            )
          }
        </Field>
        <Field label="Draw type" readOnly={readOnly}>
          {() =>
            canEdit ? (
              <OptionSelect
                ariaLabel="Draw type"
                value={event.drawType}
                options={DRAW_TYPE_OPTIONS}
                onChange={(v) => set({ drawType: v as DrawType })}
              />
            ) : (
              <ReadOnlyValue>
                {optionLabel(DRAW_TYPE_OPTIONS, event.drawType)}
              </ReadOnlyValue>
            )
          }
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Player limit"
          hint="Hard cap. Waitlist opens past this."
          readOnly={readOnly}
        >
          {(id) =>
            canEdit ? (
              <Input
                id={id}
                type="number"
                min={2}
                max={512}
                value={event.maxPlayers}
                onChange={(e) => set({ maxPlayers: Number(e.target.value) })}
              />
            ) : (
              <ReadOnlyValue>{numericValue(event.maxPlayers)}</ReadOnlyValue>
            )
          }
        </Field>
        <Field label="Entry fee" readOnly={readOnly}>
          {(id) =>
            canEdit ? (
              <Input
                id={id}
                type="number"
                min={0}
                value={event.entryFee}
                onChange={(e) => set({ entryFee: Number(e.target.value) })}
              />
            ) : (
              <ReadOnlyValue>{numericValue(event.entryFee)}</ReadOnlyValue>
            )
          }
        </Field>
      </div>

      <div className="my-1 flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
          Time slot
        </span>
        <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-4">
        <Field label="Date" readOnly={readOnly}>
          {(id) =>
            canEdit ? (
              <Input
                id={id}
                type="date"
                value={event.slot.date}
                onChange={(e) => setSlot({ date: e.target.value })}
              />
            ) : (
              <ReadOnlyValue>{event.slot.date}</ReadOnlyValue>
            )
          }
        </Field>
        <Field label="Start" readOnly={readOnly}>
          {(id) =>
            canEdit ? (
              <Input
                id={id}
                type="time"
                className="font-mono"
                value={event.slot.start}
                onChange={(e) => setSlot({ start: e.target.value })}
              />
            ) : (
              <ReadOnlyValue className="font-mono">
                {event.slot.start}
              </ReadOnlyValue>
            )
          }
        </Field>
        <Field label="End" readOnly={readOnly}>
          {(id) =>
            canEdit ? (
              <Input
                id={id}
                type="time"
                className="font-mono"
                value={event.slot.end}
                onChange={(e) => setSlot({ end: e.target.value })}
              />
            ) : (
              <ReadOnlyValue className="font-mono">
                {event.slot.end}
              </ReadOnlyValue>
            )
          }
        </Field>
      </div>
    </div>
  )
}
