import { Input } from '@/components/ui/input'

import type { EditFreeze } from '../../data/draw'
import { ENTRY_FEE_MAX, PLAYERS_MAX } from '../../data/event-validation'
import { fmtDate } from '../../data/helpers'
import { DRAW_TYPE_OPTIONS, FORMAT_OPTIONS, labelFor } from '../../data/options'
import type { DrawType, EventFormat, TournamentEvent } from '../../data/types'
import { Field } from '../../field'
import { SectionHeader } from '../section-header'
import { OptionSelect } from './option-select'

/** Inline validation messages for the scalar fields this section owns, mapped
 * from the editor's React-Hook-Form state. Present only for a field the resolver
 * (or the server) rejected; absent otherwise. Never shown to a viewer — `Field`
 * drops the hint slot in its read-only branch (ADR 0015). */
export interface BasicsFieldErrors {
  name?: string
  maxPlayers?: string
  entryFee?: string
}

export interface BasicsSectionProps {
  event: TournamentEvent
  /** When false (a non-creator), the section renders values instead of
   * controls — a viewer gets a rendering of the data, never a disabled form
   * (ADR 0015). */
  canEdit: boolean
  /** Inline errors for the name / player-limit / entry-fee fields, surfaced below
   * the control in red (`CLAUDE.md`, `## Forms`). The section does not *decide*
   * these: the editor resolves the whole form on submit and hands each tab its
   * share, so "may I save?" and "what does this field say in red?" are one answer,
   * computed once — exactly as the rule rows already work. */
  errors?: BasicsFieldErrors
  /** Whether the **draw type** may still be changed (`drawTypeFreeze`, `data/draw`).
   * Frozen once the event's draw is cut: the fixtures were dealt *as* that type, and
   * re-labelling it would leave the event claiming a shape its draw does not have — a
   * 409 on the server (ADR-0786). Frozen means a **disabled select with the reason in
   * text beneath it**, not a hidden row: the value is still the event's, and a director
   * who cannot see why they are stuck cannot get unstuck. (Contrast the *viewer* case,
   * where the whole control is simply absent — ADR-0015.) */
  drawTypeFreeze: EditFreeze
  onChange: (next: TournamentEvent) => void
}

/** The two numeric fields are **unset** in two different ways, and a reader is owed
 * an em-dash for either — never the literal string "NaN" (what `ReadOnlyValue` would
 * print for a cleared fee) and never `0` (a real, different answer: an event that is
 * free to enter).
 *
 * The player limit reaches a reader as `null` when the event is uncapped (ADR-0935);
 * the entry fee, whose blank box is a *missing* value rather than a state of the
 * event, reaches it as `NaN`. Both mean "nothing here". */
const numericValue = (n: number | null): number | null =>
  n === null || Number.isNaN(n) ? null : n

/** The event editor's "Basics" tab: name, format, draw type, caps, and the
 * time-slot window. Each row declares its control *and* the value it holds;
 * `readOnly` is what picks between them, so a viewer's rows line up with an
 * editor's and neither can drift (ADR 0015).
 *
 * That single flag also drops the form's furniture (the required asterisks and
 * the hints): the rows still declare `required` and `hint` unconditionally, and
 * `Field` suppresses them for a viewer.
 *
 * The read-only `value` is what a *reader* needs, not what the control needs: an
 * option's label rather than the enum key it is stored under, and a formatted
 * date rather than the `YYYY-MM-DD` an `<input type="date">` wants. */
export const BasicsSection = ({
  event,
  canEdit,
  errors = {},
  drawTypeFreeze,
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
        error={!!errors.name}
        hint={errors.name}
      >
        {/* `hintId` is the row's hint — here the red message, when there is one. A
            control that does not point at it is a control whose error is *beside* it on
            screen and nowhere at all to a screen reader (`Field`, `FieldControl`). */}
        {(id, hintId) => (
          <Input
            id={id}
            autoFocus
            value={event.name}
            aria-invalid={!!errors.name}
            aria-describedby={hintId}
            placeholder="Open Singles"
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </Field>

      {/* **Stacked below `sm`, side by side above it** — the same breakpoint the sheet
          itself switches on (`w-full sm:w-[820px]`), and the same rule the rule builder
          learned one tab over: a grid column cannot be narrower than the widest thing
          in it, so on a phone these rows do not get columns, they get lines. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        {/* The draw type is the strategy that DEALT this event's fixtures, so once a
            draw exists it is frozen (ADR-0786). The select is disabled and the reason
            sits under it as text — the hint slot, the same place a validation message
            would go — because a disabled trigger can carry no tooltip a screen reader
            would read, and "the button is grey and nobody said why" is the dead end
            ADR-0015 exists to forbid. It is not an error, so it is not red: the event is
            fine, this one control is merely spoken for.

            Hidden would be worse: the draw type is a fact about the event the director
            came here to check, and hiding it would answer a question they did not ask
            while silently dropping the one they did. */}
        <Field
          label="Draw type"
          readOnly={readOnly}
          value={labelFor(DRAW_TYPE_OPTIONS, event.drawType, null)}
          hint={
            drawTypeFreeze.kind === 'frozen' ? drawTypeFreeze.reason : undefined
          }
        >
          {/* The trigger POINTS at the reason (`aria-describedby`), it does not merely
              sit above it. A disabled trigger is not focusable and carries no tooltip,
              so the description is the only channel it has left — and one it had, in
              fact, been leaving empty (`aria-describedby: null`) while the pools section
              one tab over wired the identical freeze correctly. */}
          {(_id, hintId) => (
            <OptionSelect
              ariaLabel="Draw type"
              value={event.drawType}
              options={DRAW_TYPE_OPTIONS}
              disabled={drawTypeFreeze.kind === 'frozen'}
              describedById={hintId}
              onChange={(v) => set({ drawType: v as DrawType })}
            />
          )}
        </Field>
      </div>

      {/* ⚠️ **Neither box may coerce a blank into a number** — and they blank to two
          different things, because they *mean* two different things (ADR-0935).
          `Number('')` is `0`, and that one coercion told two separate lies: a player
          limit of zero (an event admitting nobody, which the server 422s) and an entry
          fee of zero (a free event — a price the organizer never named). So a blank cap
          is `null` (no cap: valid, and it saves) and a blank fee is `NaN` (missing: an
          inline required error). Neither is ever `0`.

          The `max` attributes are advisory and always were: an `<input type=number max>`
          steers a spinner and stops nothing that is typed or pasted. The bound that BINDS
          is the schema's (`PLAYERS_MAX` / `ENTRY_FEE_MAX`, `data/event-validation`) —
          9999999999 sailed through this attribute and landed on an `Integer` column,
          which is a **500**. They are set from the same constants, so the spinner and the
          rule cannot say different numbers. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Player limit"
          // No required asterisk: a blank field is a real, valid state — an event with
          // no cap — and the hint says so out loud, so an organizer who wants one does
          // not have to guess that emptying the box is allowed. The error, when there is
          // one, takes the hint's place: the thing that is wrong outranks the thing that
          // is merely worth knowing.
          error={!!errors.maxPlayers}
          hint={errors.maxPlayers ?? 'Blank = no cap. Waitlist opens past this.'}
          readOnly={readOnly}
          value={numericValue(event.maxPlayers)}
        >
          {(id, hintId) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={PLAYERS_MAX}
              aria-invalid={!!errors.maxPlayers}
              aria-describedby={hintId}
              // Hold empty as empty and submit `null`.
              value={event.maxPlayers ?? ''}
              onChange={(e) =>
                set({
                  maxPlayers:
                    e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
        <Field
          label="Entry fee"
          required
          error={!!errors.entryFee}
          hint={errors.entryFee}
          readOnly={readOnly}
          value={numericValue(event.entryFee)}
        >
          {(id, hintId) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={ENTRY_FEE_MAX}
              aria-invalid={!!errors.entryFee}
              aria-describedby={hintId}
              // Blank is `NaN` — *missing* — while a typed `0` is a legitimate free
              // event and saves.
              value={Number.isNaN(event.entryFee) ? '' : event.entryFee}
              onChange={(e) =>
                set({
                  entryFee: e.target.value === '' ? NaN : Number(e.target.value),
                })
              }
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

      {/* The row that was still off the screen after round three's responsive pass fixed
          the rule row one tab over — the identical bug, in the identical shape, on the
          tab the editor OPENS on (#783 QA, round four).

          `1.4fr 1fr 1fr` looks fluid and is not: a grid item's `min-width` is `auto`, so
          no column may be narrower than its content, and a date input plus two time
          inputs have a min-content width of ~350px before the gaps. On a 375px phone the
          End time therefore rendered at **x=339..467** — a hundred pixels past the edge
          of the world, reachable only by a sideways scroll of the sheet that nothing
          advertises. Three columns become three lines where there is room for one. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1.4fr_1fr_1fr]">
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
