import { z } from 'zod'
import type { FieldErrors } from 'react-hook-form'

import { drawTypeSchema } from '../data/draw-types'
import {
  entryFeeSchema,
  maxPlayersSchema,
  nameSchema,
  reservationNameSchema,
  qualifiersPerGroupSchema,
  swissRoundsSchema,
  type EventSection,
} from '../data/event-validation'
import { browserTimezone, fmtDate, fmtTimeWindow, inPositionOrder } from '../data/helpers'
import { PRED_OPS_BY_TYPE, type PredicateOp } from '../data/options'
import { keepReservations, reservationEntryKey } from '../data/reservation-entries'
import { eligibilityIssues } from '../data/predicate-validation'
import type {
  ReservationEntry,
  Predicate,
  PredicateValue,
  TournamentEvent,
} from '../data/types'

/** A `YYYY-MM-DD` date with `HH:MM` start/end — the shape both an event and a
 * reservation carry (mirrors `Slot` in `data/types`). */
const slotSchema = z.object({
  date: z.string(),
  start: z.string(),
  end: z.string(),
})

/** The shape both an event's `slot` and a reservation's `slot` share — named once so
 * #1501's ordering/containment predicates below can judge either without caring which
 * one they were handed. */
type SlotDraft = z.infer<typeof slotSchema>

/** An eligibility predicate's value: a rating, a `[min, max]` pair for `between`,
 * or unset. Typed as `PredicateValue` rather than inferred, so the form's value and
 * the domain's cannot drift — the vocabulary is one numeric field (`rating`,
 * ADR-0783), and a form that could hold a string here would be a form that could
 * author a payload the API 422s.
 *
 * **Both** generics are pinned (`ZodType<Out, In>`), not just the output: zod's `Input`
 * defaults to `unknown`, and an `unknown` input is what React-Hook-Form's resolver reads
 * to type the form's *values* — so annotating only the output silently gives the form a
 * `predicates: unknown[]`, and every row that hands a field back as a `Predicate` needs a
 * cast to get there. Pin both and the seam type-checks itself. */
const predicateValueSchema: z.ZodType<PredicateValue, PredicateValue> = z.union([
  z.number(),
  z.tuple([z.number().nullable(), z.number().nullable()]),
  z.null(),
])

/** The operators a rule may use — **read off the builder's own table**
 * (`PRED_OPS_BY_TYPE`, `data/options`), never re-typed beside it. That table is
 * already the single source of the operators the builder *renders* and the ones a
 * `Predicate` is *allowed to hold*; a third list here is a third thing to drift, and
 * `op: 'is'` is a 422. */
const opSchema = z.custom<PredicateOp>(
  (value) =>
    typeof value === 'string' &&
    PRED_OPS_BY_TYPE.number.some((option) => option.value === value),
  { error: 'Choose an operator.' },
)

/** One ANDed eligibility rule — `field`/`operator`/`value`, plus the stable id the
 * row is keyed on. Typed as the domain's `Predicate`, so the nested-array sub-form is
 * validated by the same resolver as the scalar fields (chore 1e) *and* the rows can
 * hand a form field straight back as a `Predicate` with no cast.
 *
 * The *shape* is all this says. Whether the rule is one the server could evaluate and
 * a player could satisfy — that it has a value at all, that a `between` runs low→high,
 * that a rating is a rating — is `predicateIssues` (`data/predicate-validation`),
 * applied to the whole list in `eventSchema` below. */
const predicateSchema: z.ZodType<Predicate, Predicate> = z.object({
  id: z.string(),
  field: z.literal('rating'),
  op: opSchema,
  value: predicateValueSchema,
})

/** The three fields of a reservation a director actually types — the `ReservationDraft`
 * both arms of `reservationEntrySchema` carry, spelled once so the two arms cannot drift
 * into disagreeing about what a reservation *is*.
 *
 * `name` carries the server's floor (`reservationNameSchema`, `data/event-validation`) —
 * the one field of a reservation the organizer can *clear*, and a `min_length=1` 422 if
 * they do. */
const RESERVATION_DRAFT_FIELDS = {
  name: reservationNameSchema,
  slot: slotSchema,
  tableIds: z.array(z.string()),
}

/**
 * One reservation of the edited event — the domain's `ReservationEntry` (`data/types`),
 * which is a **tagged union and not a reservation with an optional id**, because the
 * editor is building an id-keyed diff (ADR 20260801):
 *
 * - `kept` cites the uuid the server minted, so the reservation keeps its identity —
 *   and, with it, the group mapped 1:1 onto it, and every fixture dealt into that group;
 * - `added` has no `id` field at all, so a client-minted one is not a value this form can
 *   hold. That absence is the whole chore: `ReservationWrite` is `extra="forbid"`, so an
 *   `id` on a new reservation is a 422 naming it.
 *
 * There is no `position` on either arm, for the same reason there is no id on one of
 * them: it is the SERVER's to assign, from the index of each entry in the list that is
 * sent (`reservationEntriesToApi`, `data/api` — a `position` on a write body is a 422).
 * **The order of the field array IS the ordering**, which is why `eventToFormValues`
 * seeds it in position order below.
 *
 * Typed as `ReservationEntry` for the same reason `predicateSchema` is typed as
 * `Predicate`: the reservations section hands a form field straight back as one, and a
 * mirror that were merely *similar* would need a cast to cross that seam.
 */
const reservationEntrySchema: z.ZodType<ReservationEntry, ReservationEntry> =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('kept'), id: z.string(), ...RESERVATION_DRAFT_FIELDS }),
    z.object({ kind: z.literal('added'), key: z.string(), ...RESERVATION_DRAFT_FIELDS }),
  ])

/**
 * The client's own sentence for #1482's reservation cap — raised inline, before the
 * request ever goes out, so a director sees this rather than the server's prose
 * (`DEFINITION_OF_COMPLETE`). Takes the count actually held, so "it currently holds
 * 2" stays true whatever the director's list happens to be.
 *
 * Deliberately its own words, not a transplant of the server's `enforce_event_
 * reservation_cap` sentence: that one is about the WRITE the server just refused
 * (`api/app/schemas/tournament.py`); this one is about the DRAFT the director is
 * still editing, before any request exists to refuse.
 *
 * **Names the draw type in the domain's words, never the wire token.** The server's
 * sentence says `rr-then-ko` because its audience is an API or MCP caller, for whom
 * that string is exactly what they must send. A director's audience is the Basics
 * tab's picker, which renders the label the `draw_types` table serves — and
 * `rr-then-ko` appears nowhere on it. Telling a director to choose an option that is
 * not on the menu makes this the one instruction the cap gives unfollowable.
 *
 * It is prose about one draw type, NOT a label lookup, and that distinction is what
 * keeps it inside ADR 20260726: the ban is on a client-side *catalogue* of draw types
 * and labels that has to agree with the server's seed by hand. There is still exactly
 * one menu, still served. This sentence names the concept the way `CONTEXT.md` does.
 */
function reservationCapMessage(count: number): string {
  return (
    `This event can hold only one reservation while its draw type runs a single ` +
    `group — it currently holds ${count}. Remove reservations until one remains, ` +
    `or change the draw type on the Basics tab to a round-robin-then-knockout draw, ` +
    `which runs several groups.`
  )
}

/**
 * **The reservation cap's one predicate (#1482)** — is this draw type / count pair over
 * the cap? Exported because it has TWO consumers that must never disagree: the
 * `superRefine` below, which decides whether the SAVE is refused, and the reservations
 * section, which decides whether the refusal's sentence is still TRUE to show.
 *
 * They must never disagree because the refusal is raised at the reservations ARRAY's
 * path while its condition reads `drawType`, a DIFFERENT field — and React-Hook-Form
 * revalidates the field that changed, never a sibling. So the section cannot trust the
 * error object to have kept up, and re-derives the condition instead. Two hand-written
 * copies of "over the cap" is exactly the drift this file already refuses for the field
 * rules ("Two schemas for one field drift"): one copy fixed, the other not, and the
 * screen goes back to contradicting itself.
 */
export function isOverReservationCap(
  drawType: EventFormValues['drawType'],
  reservationCount: number,
): boolean {
  return drawType !== 'rr-then-ko' && reservationCount > 1
}

/**
 * **A slot's own ordering (#1501)** — is `end` strictly after `start`? Comparing the two
 * `HH:MM` strings directly is safe: an `<input type="time">` never emits anything but a
 * zero-padded, fixed-width `HH:MM`, so lexicographic order and clock order agree. A
 * zero-length window (`end === start`) is refused along with a genuinely inverted one —
 * a slot that starts and ends at the same instant reserves no time at all, exactly as
 * the server's mirrored rule (`_slot_is_well_formed`) refuses it.
 *
 * Exported because it judges TWO different slots the same way: the event's own `slot`
 * on Basics, and every reservation's `slot` on Reservations (#1501's rules 3 and 1) —
 * one predicate, so the two tabs can never disagree about what "ordered" means.
 */
export function isSlotOrdered(slot: SlotDraft): boolean {
  return slot.end > slot.start
}

/** A `YYYY-MM-DD` date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** An `HH:MM` time — no seconds. The same shape the server's parse rule asks of the
 * event's own slot (#1501, rule 3). */
const TIME_PATTERN = /^\d{2}:\d{2}$/

/**
 * **The event's own slot is well-formed (#1501, rule 3's parse half)** — a real date, a
 * real time either side, no seconds. `<input type="date">` / `<input type="time">`
 * cannot *emit* anything malformed, but they CAN be cleared: a director who blanks the
 * Date box (or either time box) and presses Save has authored `''`, a value the boxes
 * themselves happily hold.
 *
 * That value is not merely blank, it is DANGEROUS: `isSlotOrdered`'s `end > start`
 * string comparison treats `''` as sorting before every real `HH:MM`, so a blank Start
 * with a real End reads as "ordered" — and a blank Date with no reservations to trip
 * containment on would sail through both #1501 checks and build a request the server
 * 422s on `date.fromisoformat('')`. This predicate is what stops it: asked BEFORE
 * ordering (see the `superRefine` below), so a cleared box is told it is empty, never
 * that its window "must end after it starts."
 *
 * Scoped to the EVENT's own slot only. A reservation's slot has no parse rule of its own
 * to mirror here — clearing one of its three boxes is already caught by containment or
 * ordering once the event's own slot is well-formed (a blank reservation date can never
 * equal a real event date; a blank reservation time sorts outside a real event window on
 * at least one side) — see `event-validation.ts`'s mirror-table entry for the fuller
 * accounting of what is, and is not, mirrored here.
 */
export function isEventSlotWellFormed(slot: SlotDraft): boolean {
  return (
    DATE_PATTERN.test(slot.date) &&
    TIME_PATTERN.test(slot.start) &&
    TIME_PATTERN.test(slot.end)
  )
}

/**
 * **A reservation's containment inside its event's window (#1501, rule 2)** — on the
 * SAME date, and no earlier than the event starts, no later than the event ends. Bounds
 * are INCLUSIVE: a reservation whose window exactly equals the event's is legal — the
 * seeded `ev-cc-open` / `p-cc-1` pair (`mocks/tournaments-store.ts`) is exactly this
 * case, and refusing it would refuse a save the server accepts.
 *
 * Because a `Slot` carries one `date`, containment on the date axis is EQUALITY, not a
 * range — the same reasoning the server's rule follows.
 */
export function isReservationContained(
  reservationSlot: SlotDraft,
  eventSlot: SlotDraft,
): boolean {
  return (
    reservationSlot.date === eventSlot.date &&
    reservationSlot.start >= eventSlot.start &&
    reservationSlot.end <= eventSlot.end
  )
}

/**
 * The client's own sentence for a window (a reservation's, or the event's own) whose
 * `end` is not strictly after its `start` — #1501's ordering rule, raised inline before
 * any request exists. Deliberately its own words, not the server's `_slot_is_well_formed`
 * message, the same reason `reservationCapMessage` is not a transplant of the server's
 * cap sentence.
 */
function slotOrderMessage(): string {
  return 'This window must end after it starts.'
}

/**
 * The client's own sentence for an event slot with a cleared box — #1501, rule 3's
 * parse half (`isEventSlotWellFormed`). Named after what the director actually did
 * (left a box empty), never "invalid" or "malformed": the fix is to fill it back in,
 * and the sentence should say so.
 */
function slotParseMessage(): string {
  return 'The date and both times are required.'
}

/**
 * The client's own sentence for a reservation whose window falls outside its event's —
 * #1501's containment rule. **States the event's own window**, so the director can read
 * the target without leaving the Reservations tab for Basics — a constraint Discovery
 * carried straight into the acceptance criteria.
 */
function reservationWindowMessage(eventSlot: SlotDraft): string {
  return (
    `This reservation must fall on ${fmtDate(eventSlot.date)}, between ` +
    `${fmtTimeWindow(eventSlot.start, eventSlot.end)} — the event's own window.`
  )
}

/**
 * What is wrong with each reservation's **window**, keyed by `reservationEntryKey` —
 * #1501's ordering and containment rules, read a second way for the tab that puts the
 * red under the box (mirrors `reservationNameIssues`, `data/event-validation`, for the
 * identical reason: RHF's `useFieldArray.update()` does not re-run the resolver, so a
 * card's own edit has to be re-judged from LIVE form values or the red would outlive
 * the fix — see `ReservationsSection`'s `nameIssues` doc for the full mechanism).
 *
 * Ordering is asked before containment, for one row at a time: an end-before-start
 * window is already wrong regardless of what the event's slot says, so there is never a
 * reason to also tell the director it is outside a window it cannot even form.
 *
 * **Says nothing about ANY row when the event's own slot cannot frame one** — cleared,
 * malformed, or itself end-before-start. A containment message quotes the event's
 * window (`reservationWindowMessage`), and there is no honest window to quote against
 * an event slotted (say) `18:00`–`09:00`: every reservation would read "must fall
 * between 18:00–09:00", a window that cannot exist, sending the director back to
 * Reservations to fit inside something Basics already told them to fix first. The event
 * slot IS the thing to fix first — the same reasoning ordering-before-containment uses
 * for one row, one level up.
 *
 * The two `superRefine`s below call this SAME function for the verdict that refuses the
 * save, so the refusal and the red under the box can never say two different things.
 */
export function reservationWindowIssues(
  reservations: readonly ReservationEntry[],
  eventSlot: SlotDraft,
): Record<string, string> {
  if (!isEventSlotWellFormed(eventSlot) || !isSlotOrdered(eventSlot)) return {}
  const issues: Record<string, string> = {}
  for (const reservation of reservations) {
    if (!isSlotOrdered(reservation.slot)) {
      issues[reservationEntryKey(reservation)] = slotOrderMessage()
      continue
    }
    if (!isReservationContained(reservation.slot, eventSlot)) {
      issues[reservationEntryKey(reservation)] = reservationWindowMessage(eventSlot)
    }
  }
  return issues
}

/**
 * The one schema the editor's `zodResolver` runs — the whole event, scalars and
 * nested arrays alike, so "may I save?" has a single answer computed in a single
 * place.
 *
 * The field rules are **imported, not restated** (`data/event-validation`,
 * `data/predicate-validation`). Two schemas for one field drift, and a drifted schema
 * is how a bound gets fixed on one tab and not the other. In particular:
 *
 * - `maxPlayers` is **nullable**: a blank cap is `null` — an uncapped event, and a
 *   perfectly good thing to save (ADR-0935). It is not an error, and never a `0`.
 * - `entryFee` is **required**: a blank fee arrives as `NaN` and is an inline error,
 *   while a typed `0` is a free event and saves.
 * - `predicates` is refined by `eligibilityIssues`, which is the one guard here with
 *   no server-side twin to mirror: the API is deliberately MORE permissive about a
 *   half-written rule than the product is (it accepts `Rating < ?`, a restriction on
 *   nobody, and renders it on the card as though it were real).
 * - `reservations` carries the newest of the server's floors: a reservation's `name` may
 *   not be blank (`reservationNameSchema`). The reservations editor mints the default
 *   name, so only the *box* could ever author a blank one — and it did. (The id it no
 *   longer mints at all; see `reservationEntrySchema`.)
 */
export const eventSchema = z.object({
  name: nameSchema,
  format: z.enum(['singles', 'doubles', 'teams']),
  // Exactly the API's `DrawType` (ADR 20260726): a member exists iff the server can
  // plan it, and the three that could not are a 422 at the request boundary now. The
  // slugs are NOT re-typed here — this is the one vocabulary declared in
  // `data/draw-types`, pinned to the generated schema by a compile-time assertion in
  // `data/draw-types.test.ts`.
  drawType: drawTypeSchema,
  // **K**, held as `number | null` and judged BELOW, with the draw type beside it — the
  // shape rule only (ADR 20260727). `null` is the honest value for the three draw types
  // that have no knockout stage, and it is the *blank box* for the one that does; which
  // of those two things it is depends on `drawType`, which a field-level rule cannot
  // see. See `qualifiersPerGroupSchema` (`data/event-validation`) for why the pair, and
  // not the field, carries the bound.
  qualifiersPerGroup: z.number().nullable(),
  // **R**, held the same way and judged in the same place, beside the draw type that
  // decides whether it is asked at all (the swiss ADR). `null` is the honest value for the
  // three draw types whose round count nobody chooses, and it is the *blank box* for the
  // one whose director does.
  rounds: z.number().nullable(),
  maxPlayers: maxPlayersSchema,
  entryFee: entryFeeSchema,
  // The IANA timezone anchoring the wall-clock windows (ADR 20260719). `NOT NULL`
  // on the server and required here to mirror it — a non-empty string is the whole
  // client-side rule: whether it names a *known* zone is the server's to judge (an
  // unknown one is a 422), and re-listing every IANA name here to pre-empt that
  // would be a second copy of the tz database to drift. The picker only ever offers
  // real zones, so this floor is a backstop, not the gate.
  timezone: z.string().trim().min(1, { error: 'Choose a timezone.' }),
  slot: slotSchema,
  match: z.object({
    rated: z.boolean(),
    lengthGames: z.union([
      z.literal(1),
      z.literal(3),
      z.literal(5),
      z.literal(7),
    ]),
  }),
  // The issue is raised on the ARRAY, not on a row. The per-row red already comes from
  // `eligibilityIssues`, which addresses the *control* holding the bad value — and a
  // zod path cannot: `between`'s two bounds live inside a single `value` tuple, so
  // "the upper bound" is not a form field there is a path to. What the resolver needs
  // from this is the one bit "is this event sendable?", plus a marker
  // `firstInvalidSection` can read to open the right tab. One validator, two consumers
  // — not two validators.
  predicates: z.array(predicateSchema).superRefine((predicates, ctx) => {
    const issues = eligibilityIssues(predicates)
    if (Object.keys(issues).length === 0) return
    ctx.addIssue({
      code: 'custom',
      message: 'Every rule needs a value the server can evaluate.',
    })
  }),
  reservations: z.array(reservationEntrySchema),
})
  // The **draw configuration** is judged as a pair, because that is what it is: the
  // server parses `(draw_type, qualifiers_per_group)` into a union tagged by the draw
  // type, one arm of which requires a count and two of which forbid the key outright
  // (ADR 20260727). So the count's bound is asked here, where both halves are in scope,
  // rather than on the field.
  //
  // Only the `rr-then-ko` arm is asked at all: for the other two, `qualifiersPerGroup` is
  // `null`, there is no control on screen (the Basics tab renders it only for the
  // two-stage type), and the write body omits the key entirely (`eventToApiFields`,
  // `data/api`) — so a rule that fired there would refuse a save for a reason the
  // director cannot see, let alone fix. The issue is raised **at the field's own path**,
  // so React-Hook-Form reports it as `errors.qualifiersPerGroup` and the red lands under
  // the box, exactly as a field-level rule's would.
  .superRefine((values, ctx) => {
    if (values.drawType !== 'rr-then-ko') return
    const result = qualifiersPerGroupSchema.safeParse(values.qualifiersPerGroup)
    if (result.success) return
    ctx.addIssue({
      code: 'custom',
      path: ['qualifiersPerGroup'],
      // The schema's own sentence, never a second one typed beside it — the same rule
      // `reservationNameIssues` follows for the reservation names.
      message: result.error.issues[0].message,
    })
  })
  // **R** is judged as half of the same pair, for the same reason and by the same shape
  // (ADR "swiss pre-cuts every round and pairs each one on advance"): the server parses
  // `(draw_type, rounds)` into a union tagged by the draw type, one arm of which requires a
  // round count and three of which forbid the key outright.
  //
  // Only the `swiss` arm is asked at all: for the other three, `rounds` is `null`, there is
  // no control on screen (the Basics tab renders it only for swiss), and the write body
  // omits the key entirely (`drawSettingsToApi`, `data/api`) — so a rule that fired there
  // would refuse a save for a reason the director cannot see, let alone fix. The issue is
  // raised **at the field's own path**, so React-Hook-Form reports it as `errors.rounds`
  // and the red lands under the box.
  .superRefine((values, ctx) => {
    if (values.drawType !== 'swiss') return
    const result = swissRoundsSchema.safeParse(values.rounds)
    if (result.success) return
    ctx.addIssue({
      code: 'custom',
      path: ['rounds'],
      message: result.error.issues[0].message,
    })
  })

  // **The reservation cap (#1482)**: a non-`rr-then-ko` event holds AT MOST ONE
  // reservation — every other draw type runs its whole stage as one group (ADR
  // 20260808), so `enforce_event_reservation_cap` (`api/app/schemas/tournament.py`)
  // refuses a second one at the request boundary. Raised at the ARRAY's own path
  // (`['reservations']`), the same shape `qualifiersPerGroup` and `rounds` use above:
  // the refusal is about the LIST against the draw type beside it, not about any one
  // row, so `firstInvalidSection` (below) already opens the Reservations tab off the
  // mere truthiness of `errors.reservations` — no change needed there.
  //
  // Not enforced by freezing the Basics draw-type select: the reservations are the
  // thing the director has to change, and freezing the picker would point them at the
  // wrong tab entirely (Planning's interview, #1482).
  //
  // The MESSAGE is the client's own copy (`reservationCapMessage` below), never the
  // server's sentence — `DEFINITION_OF_COMPLETE`: a raw API detail string never
  // reaches the UI. The server's own words still arrive verbatim when a director
  // loses the race and the save is refused anyway (`save-failure.ts`'s `refused` arm,
  // unchanged by this ticket).
  .superRefine((values, ctx) => {
    if (!isOverReservationCap(values.drawType, values.reservations.length)) return
    ctx.addIssue({
      code: 'custom',
      path: ['reservations'],
      message: reservationCapMessage(values.reservations.length),
    })
  })

  // **Reservation ordering + containment (#1501, rules 1 and 2)**: raised PER ROW at
  // that reservation's own `slot` path — the same shape a per-row error already has for
  // a blank name (`RESERVATION_DRAFT_FIELDS.name`), so `firstInvalidSection`'s existing
  // `errors.reservations` arm already opens the right tab with no change of its own.
  //
  // The verdict is `reservationWindowIssues` above, never re-derived here: one rule, two
  // readers (the resolver that refuses the save, and `ReservationsSection`'s live-value
  // channel that puts the red under the box) — the same discipline `reservationCapMessage`
  // /`isOverReservationCap` already follow.
  .superRefine((values, ctx) => {
    const issues = reservationWindowIssues(values.reservations, values.slot)
    values.reservations.forEach((reservation, i) => {
      const message = issues[reservationEntryKey(reservation)]
      if (!message) return
      ctx.addIssue({
        code: 'custom',
        path: ['reservations', i, 'slot'],
        message,
      })
    })
  })

  // **The event's own slot — parse, then ordering (#1501, rule 3)**: mirrors the
  // reservation's own ordering rule, one level up — an event slotted end-before-start
  // makes every reservation uncontainable (containment above can never pass), so this
  // has to refuse before the Reservations tab is even worth judging. Raised on `slot`
  // itself, so `firstInvalidSection`'s new `errors.slot` arm can route a director to the
  // tab that holds it — the Basics tab, under the time-slot fields (`BasicsSection`).
  //
  // Parse is asked FIRST: a cleared Date/Start/End box is `''`, and `isSlotOrdered`'s
  // string comparison treats `''` as sorting before every real `HH:MM` — so a blank
  // Start next to a real End reads as "ordered", and the request would go out with a
  // date the server 500s trying to parse. A cleared box is told it is empty, never
  // that its window "must end after it starts."
  .superRefine((values, ctx) => {
    if (!isEventSlotWellFormed(values.slot)) {
      ctx.addIssue({
        code: 'custom',
        path: ['slot'],
        message: slotParseMessage(),
      })
      return
    }
    if (isSlotOrdered(values.slot)) return
    ctx.addIssue({
      code: 'custom',
      path: ['slot'],
      message: slotOrderMessage(),
    })
  })

// The schema mirrors the domain types (`Predicate`, `ReservationEntry`) so the nested-array
// sub-forms are validated by this one resolver; the section code that rebuilds a
// clean `Predicate`/`ReservationEntry` from each `useFieldArray` field is the compile-time
// check that the mirror holds.
export type EventFormValues = z.infer<typeof eventSchema>

const EMPTY_FORM_VALUES: EventFormValues = {
  name: '',
  format: 'singles',
  drawType: 'single-elim',
  // …and a bracket has no groups to qualify out of, so no qualifier count (ADR 20260727).
  // `null` is the only value the server's `single-elim` arm admits.
  qualifiersPerGroup: null,
  // …and a bracket's depth follows from the field rather than from a setting, so no round
  // count either (the swiss ADR). `null` is the only value the server's `single-elim` arm
  // admits.
  rounds: null,
  // A new event starts **uncapped**, not at an invented number: `null` is a valid,
  // saveable answer (ADR-0935), so an organizer who never touches the box gets an
  // event with no cap — rather than a form that silently refuses to submit.
  maxPlayers: null,
  // …and with NO fee, which is not the same as a free one. `NaN` is the blank box,
  // and blank stays a required error until they say which they meant.
  entryFee: NaN,
  // The browser's resolved zone (ADR 20260719): the venue's, in the single-venue
  // common case, and a starting point the director can correct otherwise. This
  // const only backs the `event === null` projection below — the real new-event
  // path is `emptyEvent` (`data/helpers`), which sets the same browser default on
  // the event the editor is handed.
  timezone: browserTimezone(),
  slot: { date: '', start: '', end: '' },
  match: { rated: true, lengthGames: 5 },
  predicates: [],
  reservations: [],
}

/** Project an event onto the editable form fields (the id, entrant list, and
 * server-derived count are carried outside the form and re-attached on save). */
export function eventToFormValues(event: TournamentEvent | null): EventFormValues {
  if (!event) return EMPTY_FORM_VALUES
  return {
    name: event.name,
    format: event.format,
    drawType: event.drawType,
    // The count the SERVER sent back, straight onto the control — this projection is the
    // near half of the round trip the read shape's `qualifiers_per_group` exists for.
    qualifiersPerGroup: event.qualifiersPerGroup,
    // …and the round count the same way, the near half of the round trip the read shape's
    // `rounds` exists for.
    rounds: event.rounds,
    maxPlayers: event.maxPlayers,
    entryFee: event.entryFee,
    timezone: event.timezone,
    slot: event.slot,
    match: event.match,
    predicates: event.predicates,
    // Every stored reservation, **cited by the id the server minted**
    // (`keepReservations`, `data/reservation-entries`) — the "change nothing about the
    // set" diff the organizer then edits by adding to it, removing from it, or
    // re-wording it. Seeding it any other way would be seeding a removal: under an
    // id-keyed diff, a stored reservation no entry cites is deleted, and its mapped
    // group's fixtures with it.
    //
    // …and **in POSITION order** (`inPositionOrder`, `data/helpers`), which is the ONE
    // place the reservations editor's order is decided. From here on the field array's
    // order IS the order: the cards render in it, `addReservation` appends to the end of
    // it, and — the reason it has to be settled here rather than at render time — a save
    // serializes it, from which the server re-derives each reservation's position
    // (`reservationEntriesToApi`, `data/api`). The sort is the last thing that reads
    // `position`; an entry does not carry one, because a client does not assign one.
    //
    // So sorting for *display* alone would be a bug with a delay on it: the director
    // would see A, B, C, save, and get back whatever order the array was really in. The
    // list they were looking at has to be the list that goes on the wire.
    reservations: keepReservations(inPositionOrder(event.reservations)),
  }
}

/**
 * The first tab holding something the resolver rejected, in the order the tabs are
 * laid out — where a refused save must take the organizer. `null` when the form is
 * clean.
 *
 * A message on a tab you cannot see is indistinguishable from a button that does
 * nothing, which is exactly what Save looked like before this existed.
 *
 * Basics before Eligibility before Reservations, deliberately: that is the order the
 * tabs are in, and with more than one broken, the name is the field they are most
 * likely to have simply not filled in — landing on a *later* tab would leave the empty
 * name behind them, unseen.
 */
export function firstInvalidSection(
  errors: FieldErrors<EventFormValues>,
): EventSection | null {
  // `qualifiersPerGroup` and `rounds` both live on Basics beside the draw type that decides
  // whether either is asked at all, so a refused two-stage or swiss save opens the tab
  // holding the empty box.
  // `slot` is the event's own time-slot window (#1501, rule 3) — cross-field, so it
  // cannot live inside one field's schema, but it lives on Basics beside the other
  // cross-field rules above, and the same reasoning applies: a save refused for a
  // window nobody can see is a button that does nothing.
  if (
    errors.name ||
    errors.qualifiersPerGroup ||
    errors.rounds ||
    errors.maxPlayers ||
    errors.entryFee ||
    errors.timezone ||
    errors.slot
  )
    return 'basics'
  if (errors.predicates) return 'eligibility'
  // A reservation with a cleared name (`reservationNameSchema`). RHF reports it per row
  // (`errors.reservations[2].name`) *and* sets the array key, so the truthiness of
  // `reservations` is the whole question here — which row it is, the card itself says,
  // in red, under the box. Match settings has no arm: every control on it is a closed
  // picker.
  if (errors.reservations) return 'reservations'
  return null
}
