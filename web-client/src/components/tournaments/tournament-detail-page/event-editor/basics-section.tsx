import { Input } from '@/components/ui/input'

import type { EditFreeze } from '../../data/draw'
import {
  ENTRY_FEE_MAX,
  PLAYERS_MAX,
  SWISS_ROUNDS_MAX,
  SWISS_ROUNDS_MIN,
} from '../../data/event-validation'
import { fmtDate } from '../../data/helpers'
import { FORMAT_OPTIONS, labelFor } from '../../data/options'
import type {
  DrawType,
  DrawTypeOption,
  EventFormat,
  TournamentEvent,
} from '../../data/types'
import { Field } from '../../field'
import { SectionHeader } from '../section-header'
import { OptionSelect } from './option-select'
import { TimezoneSelect } from './timezone-select'

/** Inline validation messages for the scalar fields this section owns, mapped
 * from the editor's React-Hook-Form state. Present only for a field the resolver
 * (or the server) rejected; absent otherwise. Never shown to a viewer — `Field`
 * drops the hint slot in its read-only branch (ADR 0015). */
export interface BasicsFieldErrors {
  name?: string
  /** The round count's inline red — only ever present for a `swiss` event, since that is
   * the only draw type the resolver asks the question of (and the only one whose control
   * is on screen). */
  rounds?: string
  maxPlayers?: string
  entryFee?: string
  /** The timezone is chosen from a picker that only ever offers real IANA zones, so
   * this is a backstop for a malformed draft the resolver still rejects (an empty
   * `timezone`, ADR 20260719) — never a message the picker itself can produce. */
  timezone?: string
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
  /** The draw formats **the server offers**, in its order — the tournament payload's
   * catalogue (ADR 20260726), threaded down from the page. This section keeps no list
   * of its own, so a format the server cannot run is not merely discouraged, it is not
   * on the menu; and the words on each option are the server's, which is what makes the
   * picker's labels and the read-only value below it one copy rather than two.
   *
   * `[]` is the degenerate "no catalogue reached this surface" case (a payload without
   * one — the list route's shape). The picker then offers nothing and the read-only
   * value falls to an em-dash: a director offered no choice is stuck loudly, which is
   * the honest failure. It never falls back to the stored slug. */
  drawTypes: DrawTypeOption[]
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

/**
 * One **draw setting** the director types a number into — today only swiss's round count
 * (R). `rr-then-ko`'s qualifiers per pool (K) used to be its second call site, and moved
 * to the Draw structure tab in chore 3e: K is a *structural* setting, and the other three
 * structural settings live together there (ADR 20260808).
 *
 * **The component stays, with one caller.** It is the shape of "a number the chosen draw
 * type asks for, that the planner deals the fixtures by, and that the server freezes the
 * moment a draw exists" — and this tab has got that wiring wrong once already: its
 * draw-type select carried the freeze while describing nothing. Inlining it back into the
 * one row would put those mechanics somewhere they read as incidental:
 *
 * - **The freeze is the draw type's** (`drawTypeFreeze`, `data/draw`), because on the server
 *   it is the same guard: `_enforce_draw_settings_frozen` compares the whole configuration,
 *   since a draw cut for `P × K` (or for R rounds) is exactly as contradicted by a changed
 *   number as by a changed type. Frozen means a **disabled box with the reason beneath it**,
 *   and the box POINTS at that reason (`aria-describedby`) — a disabled control is not
 *   focusable and carries no tooltip, so the description is the only channel it has left.
 * - **The error outranks the freeze, which outranks the advisory hint.** One slot, three
 *   things that could fill it, in the order the director needs them.
 * - **`min`/`max` are advisory and always were.** An `<input type=number max>` steers a
 *   spinner and stops nothing that is typed or pasted; the bound that BINDS is the
 *   resolver's schema. Both are stated from the same constants so the browser control and
 *   the rule cannot say different numbers (#1231 QA: an unbounded box sent `2147483648`,
 *   which overflowed the `Integer` column and 500'd).
 * - **Blank stays blank, and submits `null`.** Never `Number('')`, which is `0` — a bracket
 *   nobody advances into, or a swiss that plays nothing. A blank here is a MISSING answer to
 *   a question this draw type does ask, which is what the resolver then says in red.
 */
const DrawSettingField = ({
  label,
  value,
  min,
  max,
  hint,
  error,
  freeze,
  readOnly,
  onChange,
}: {
  label: string
  /** The setting's current value, or `null` for an unanswered box. */
  value: number | null
  /** Advisory bounds for the spinner, from the same constants the resolver binds on. */
  min: number
  max: number
  /** What the number means, in the director's words — shown when there is neither an error
   * nor a freeze to say instead. */
  hint: string
  /** The inline red, when the resolver (or the server) rejected this field. */
  error?: string
  /** Whether the event's draw type — and so this setting — is still editable. */
  freeze: EditFreeze
  readOnly: boolean
  onChange: (next: number | null) => void
}) => (
  <Field
    label={label}
    required
    readOnly={readOnly}
    value={numericValue(value)}
    error={!!error}
    hint={error ?? (freeze.kind === 'frozen' ? freeze.reason : hint)}
  >
    {(id, hintId) => (
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        aria-invalid={!!error}
        aria-describedby={hintId}
        disabled={freeze.kind === 'frozen'}
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? null : Number(e.target.value))
        }
      />
    )}
  </Field>
)

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
  drawTypes,
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
            while silently dropping the one they did.

            Both halves of the row read the SAME served catalogue — the options an editor
            picks from and the label a reader is shown — so the two can never say
            different words for one slug. The reader's fallback is `null` (an em-dash),
            never `event.drawType`: an enum key is not a thing anyone reads (ADR-0015). */}
        <Field
          label="Draw type"
          readOnly={readOnly}
          value={labelFor(drawTypes, event.drawType, null)}
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
              options={drawTypes}
              disabled={drawTypeFreeze.kind === 'frozen'}
              describedById={hintId}
              onChange={(v) => set({ drawType: v as DrawType })}
            />
          )}
        </Field>
        {/* ⚠️ **The qualifier count is NOT here** (chore 3e). It is a structural setting,
            so it sits with the other three on the Draw structure tab — the fifth tab, and
            the only one that has the derivation, the ownership badge and the cut-draw
            freeze that a two-stage draw's numbers need. This tab keeps the draw TYPE, the
            player limit and the swiss round count, and a box for K here would be a second
            control writing one field.

            **R**, and only for the one draw type whose round count anybody chooses (ADR
            "swiss pre-cuts every round and pairs each one on advance"). Absent for the
            other three: a round-robin's rounds are dealt by the circle method and a
            bracket's depth follows from the field, so this is not a box those formats leave
            blank — it is a question they do not ask. The server says the same thing by
            refusing the key outright on their arms of the draw-settings union
            (`extra="forbid"` — a 422, not a silently dropped value).

            Everything else about the row — the freeze it rides, its advisory bounds, its
            blank-is-null handling — is `DrawSettingField`'s. */}
        {event.drawType === 'swiss' && (
          <DrawSettingField
            label="Rounds"
            value={event.rounds}
            min={SWISS_ROUNDS_MIN}
            max={SWISS_ROUNDS_MAX}
            hint="How many rounds every entrant plays. Nobody is eliminated."
            error={errors.rounds}
            freeze={drawTypeFreeze}
            readOnly={readOnly}
            onChange={(rounds) => set({ rounds })}
          />
        )}
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
        {/* The frame the wall-clock times below are in (ADR 20260719): the event's
            timezone, beside the window so the director reads the two together. A
            reader sees it too — it is a fact about the event, not a control. The
            picker below is what *changes* it; this is the label. */}
        <span
          data-testid="event-timezone-label"
          className="font-mono text-[11px] text-[color:var(--fg-2)]"
        >
          {event.timezone}
        </span>
      </div>

      {/* The IANA timezone that anchors this event's windows to real instants
          (ADR 20260719). A searchable picker for an editor; the zone as text for a
          reader (`Field`'s read-only branch). Pre-filled from the browser's resolved
          zone on a new event (`emptyEvent`, `data/helpers`). */}
      <Field
        label="Timezone"
        required
        readOnly={readOnly}
        value={event.timezone}
        error={!!errors.timezone}
        hint={errors.timezone}
      >
        {(id, hintId) => (
          <TimezoneSelect
            id={id}
            ariaLabel="Timezone"
            value={event.timezone}
            describedById={hintId}
            onChange={(tz) => set({ timezone: tz })}
          />
        )}
      </Field>

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
