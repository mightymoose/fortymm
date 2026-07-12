import { Input } from '@/components/ui/input'

import type { BasicsIssues } from '../../data/event-validation'
import { fmtDate } from '../../data/helpers'
import { DRAW_TYPE_OPTIONS, FORMAT_OPTIONS, labelFor } from '../../data/options'
import type { DrawType, EventFormat, TournamentEvent } from '../../data/types'
import { Field } from '../../field'
import { SectionHeader } from '../section-header'
import { OptionSelect } from './option-select'

export interface BasicsSectionProps {
  event: TournamentEvent
  /** When false (a non-creator), the section renders values instead of
   * controls — a viewer gets a rendering of the data, never a disabled form
   * (ADR 0015). */
  canEdit: boolean
  /** What is wrong on this tab, per field (`eventIssues`, `data/event-validation`)
   * — or `undefined` while the editor is not yet showing errors. The section does
   * not *decide* this: the editor validates the whole draft on submit and hands each
   * tab its share, so "may I save?" and "what does this field say in red?" are one
   * answer, computed once (exactly as the rule rows already work). */
  issues?: BasicsIssues
  onChange: (next: TournamentEvent) => void
}

/** The numeric fields are edited through `Number(e.target.value)`, so clearing
 * one leaves `NaN` on the draft. To a reader that is an *unset* field — an
 * em-dash — not the literal string "NaN" (what `ReadOnlyValue` would print) and
 * not `0` (a real, different answer: free to enter). */
const numericValue = (n: number): number | null => (Number.isNaN(n) ? null : n)

/** The event editor's "Basics" tab: name, format, draw type, caps, and the
 * time-slot window. Each row declares its control *and* the value it holds;
 * `readOnly` is what picks between them, so a viewer's rows line up with an
 * editor's and neither can drift (ADR 0015).
 *
 * That single flag also drops the form's furniture (the required asterisks and
 * the "Hard cap…" hint): the rows still declare `required` and `hint`
 * unconditionally, and `Field` suppresses them for a viewer.
 *
 * The read-only `value` is what a *reader* needs, not what the control needs: an
 * option's label rather than the enum key it is stored under, and a formatted
 * date rather than the `YYYY-MM-DD` an `<input type="date">` wants. */
export const BasicsSection = ({
  event,
  canEdit,
  issues,
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

      {/* The name is the one field with nowhere else to be caught: blank and
          256-characters-long are both a 422, and both used to be learned from the
          server, in Pydantic's words, after the request had gone. The message is
          `NewTournamentModal`'s, because it is the same field to the person typing
          it (`data/event-validation`). */}
      <Field
        label="Event name"
        required
        readOnly={readOnly}
        value={event.name}
        error={!!issues?.name}
        hint={issues?.name}
      >
        {(id) => (
          <Input
            id={id}
            autoFocus
            aria-invalid={!!issues?.name}
            value={event.name}
            placeholder="Open Singles"
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Format"
          required
          readOnly={readOnly}
          value={labelFor(FORMAT_OPTIONS, event.format, null)}
        >
          {() => (
            <OptionSelect
              ariaLabel="Format"
              value={event.format}
              options={FORMAT_OPTIONS}
              onChange={(v) => set({ format: v as EventFormat })}
            />
          )}
        </Field>
        <Field
          label="Draw type"
          readOnly={readOnly}
          value={labelFor(DRAW_TYPE_OPTIONS, event.drawType, null)}
        >
          {() => (
            <OptionSelect
              ariaLabel="Draw type"
              value={event.drawType}
              options={DRAW_TYPE_OPTIONS}
              onChange={(v) => set({ drawType: v as DrawType })}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Clearing either number box leaves `NaN` on the draft, which goes on the
            wire as `null` — a 422 the organizer used to meet only after the request.
            The error takes the hint's place while it is there: one line under the
            control, and the thing that is wrong outranks the thing that is merely
            worth knowing. */}
        <Field
          label="Player limit"
          hint={issues?.maxPlayers ?? 'Hard cap. Waitlist opens past this.'}
          error={!!issues?.maxPlayers}
          readOnly={readOnly}
          value={numericValue(event.maxPlayers)}
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={2}
              max={512}
              aria-invalid={!!issues?.maxPlayers}
              value={event.maxPlayers}
              onChange={(e) => set({ maxPlayers: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field
          label="Entry fee"
          readOnly={readOnly}
          value={numericValue(event.entryFee)}
          error={!!issues?.entryFee}
          hint={issues?.entryFee}
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              aria-invalid={!!issues?.entryFee}
              value={event.entryFee}
              onChange={(e) => set({ entryFee: Number(e.target.value) })}
            />
          )}
        </Field>
      </div>

      <div className="my-1 flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
          Time slot
        </span>
        <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-4">
        {/* The editor's value is the raw `YYYY-MM-DD` an `<input type="date">`
            takes; a reader gets the same date in the words the event card uses
            ("Jun 13, 2026"), never the wire format. */}
        <Field
          label="Date"
          readOnly={readOnly}
          value={fmtDate(event.slot.date)}
        >
          {(id) => (
            <Input
              id={id}
              type="date"
              value={event.slot.date}
              onChange={(e) => setSlot({ date: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Start"
          readOnly={readOnly}
          value={event.slot.start}
          valueClassName="font-mono"
        >
          {(id) => (
            <Input
              id={id}
              type="time"
              className="font-mono"
              value={event.slot.start}
              onChange={(e) => setSlot({ start: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="End"
          readOnly={readOnly}
          value={event.slot.end}
          valueClassName="font-mono"
        >
          {(id) => (
            <Input
              id={id}
              type="time"
              className="font-mono"
              value={event.slot.end}
              onChange={(e) => setSlot({ end: e.target.value })}
            />
          )}
        </Field>
      </div>
    </div>
  )
}
