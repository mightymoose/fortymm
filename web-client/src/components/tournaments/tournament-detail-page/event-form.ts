import { z } from 'zod'
import type { FieldErrors } from 'react-hook-form'

import { drawOwnershipSchema, everySettingAutomatic } from '../data/draw-ownership'
import { deriveDrawStructure } from '../data/draw-structure'
import { drawTypeSchema } from '../data/draw-types'
import {
  entryFeeSchema,
  maxPlayersSchema,
  nameSchema,
  poolNameSchema,
  qualifiersPerPoolSchema,
  swissRoundsSchema,
  type EventSection,
} from '../data/event-validation'
import { browserTimezone, poolsInOrder } from '../data/helpers'
import { PRED_OPS_BY_TYPE, type PredicateOp } from '../data/options'
import { keepPools } from '../data/pool-entries'
import { eligibilityIssues } from '../data/predicate-validation'
import type {
  PoolEntry,
  Predicate,
  PredicateValue,
  TournamentEvent,
} from '../data/types'
import { previewFieldSize } from './event-editor/draw-structure-section/preview-field'

/** A `YYYY-MM-DD` date with `HH:MM` start/end — the shape both an event and a
 * pool carry (mirrors `Slot` in `data/types`). */
const slotSchema = z.object({
  date: z.string(),
  start: z.string(),
  end: z.string(),
})

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

/** The three fields of a pool a director actually types — the `PoolDraft` both arms of
 * `poolEntrySchema` carry, spelled once so the two arms cannot drift into disagreeing
 * about what a pool *is*.
 *
 * `name` carries the server's floor (`poolNameSchema`, `data/event-validation`) — the
 * one field of a pool the organizer can *clear*, and a `min_length=1` 422 if they do. */
const POOL_DRAFT_FIELDS = {
  name: poolNameSchema,
  slot: slotSchema,
  tableIds: z.array(z.string()),
}

/**
 * One pool of the edited event — the domain's `PoolEntry` (`data/types`), which is a
 * **tagged union and not a pool with an optional id**, because the editor is building an
 * id-keyed diff (ADR 20260801):
 *
 * - `kept` cites the uuid the server minted, so the pool keeps its identity and the
 *   fixtures dealt into it;
 * - `added` has no `id` field at all, so a client-minted one is not a value this form can
 *   hold. That absence is the whole chore: `PoolWrite` is `extra="forbid"`, so an `id` on
 *   a new pool is a 422 naming it.
 *
 * There is no `position` on either arm, for the same reason there is no id on one of
 * them: it is the SERVER's to assign, from the index of each entry in the list that is
 * sent (`poolEntriesToApi`, `data/api` — a `position` on a write body is a 422). **The
 * order of the field array IS the ordering**, which is why `eventToFormValues` seeds it
 * in position order below.
 *
 * Typed as `PoolEntry` for the same reason `predicateSchema` is typed as `Predicate`:
 * the pools section hands a form field straight back as one, and a mirror that were
 * merely *similar* would need a cast to cross that seam.
 */
const poolEntrySchema: z.ZodType<PoolEntry, PoolEntry> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kept'), id: z.string(), ...POOL_DRAFT_FIELDS }),
  z.object({ kind: z.literal('added'), key: z.string(), ...POOL_DRAFT_FIELDS }),
])

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
 * - `pools` carries the newest of the server's floors: a pool's `name` may not be
 *   blank (`poolNameSchema`). The pools editor mints the default name, so only the *box*
 *   could ever author a blank one — and it did. (The id it no longer mints at all; see
 *   `poolEntrySchema`.)
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
  // see. See `qualifiersPerPoolSchema` (`data/event-validation`) for why the pair, and
  // not the field, carries the bound.
  qualifiersPerPool: z.number().nullable(),
  // **R**, held the same way and judged in the same place, beside the draw type that
  // decides whether it is asked at all (the swiss ADR). `null` is the honest value for the
  // three draw types whose round count nobody chooses, and it is the *blank box* for the
  // one whose director does.
  rounds: z.number().nullable(),
  // **Who owns each structural setting**, and the two manual pool numbers (ADR 20260808).
  // The schema is the domain's own (`data/draw-ownership`), imported rather than restated
  // for the reason every other field rule here is: it already carries the server's
  // `ge=1, le=512` on the manual numbers, and a second copy would be a second thing to
  // drift. `null` is the honest value for the three draw types with no pool stage.
  drawOwnership: drawOwnershipSchema.nullable(),
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
  pools: z.array(poolEntrySchema),
})
  // The **draw configuration** is judged as a pair, because that is what it is: the
  // server parses `(draw_type, qualifiers_per_pool)` into a union tagged by the draw
  // type, one arm of which requires a count and two of which forbid the key outright
  // (ADR 20260727). So the count's bound is asked here, where both halves are in scope,
  // rather than on the field.
  //
  // Only the `rr-then-ko` arm is asked at all: for the other two, `qualifiersPerPool` is
  // `null`, there is no control on screen (the Draw structure tab exists only for the
  // two-stage type), and the write body omits the key entirely (`eventToApiFields`,
  // `data/api`) — so a rule that fired there would refuse a save for a reason the
  // director cannot see, let alone fix. The issue is raised **at the field's own path**,
  // so React-Hook-Form reports it as `errors.qualifiersPerPool` and the red lands under
  // the box, exactly as a field-level rule's would.
  //
  // ⚠️ **And it is asked only of a count the DIRECTOR owns** (ADR 20260808). A count whose
  // mode is `automatic` already has an answer — the derived one the Draw structure tab is
  // showing — and `withSuppliedQualifiers` below is what puts that answer on the wire. So
  // there is nothing missing there and nothing to refuse. Asking anyway was the shape of
  // refusal #1320 exists to remove: "Say how many players advance from each pool." under a
  // row rendering **text**, because an automatic setting has no box, addressed to a
  // director whose only way to comply is to first guess that `Set myself` exists. An event
  // with no ownership record has had nothing taken from the system, so it reads as
  // automatic too (`everySettingAutomatic`) — and `drawOwnership: null` is exactly what a
  // director gets the moment they pick the two-stage format on Basics.
  .superRefine((values, ctx) => {
    if (values.drawType !== 'rr-then-ko') return
    const ownership = values.drawOwnership ?? everySettingAutomatic()
    if (ownership.qualifiersMode !== 'manual') return
    const result = qualifiersPerPoolSchema.safeParse(values.qualifiersPerPool)
    if (result.success) return
    ctx.addIssue({
      code: 'custom',
      path: ['qualifiersPerPool'],
      // The schema's own sentence, never a second one typed beside it — the same rule
      // `poolNameIssues` follows for the pool names.
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

// The schema mirrors the domain types (`Predicate`, `PoolEntry`) so the nested-array
// sub-forms are validated by this one resolver; the section code that rebuilds a
// clean `Predicate`/`PoolEntry` from each `useFieldArray` field is the compile-time
// check that the mirror holds.
export type EventFormValues = z.infer<typeof eventSchema>

const EMPTY_FORM_VALUES: EventFormValues = {
  name: '',
  format: 'singles',
  drawType: 'single-elim',
  // …and a bracket has no pools to qualify out of, so no qualifier count (ADR 20260727).
  // `null` is the only value the server's `single-elim` arm admits.
  qualifiersPerPool: null,
  // …and a bracket's depth follows from the field rather than from a setting, so no round
  // count either (the swiss ADR). `null` is the only value the server's `single-elim` arm
  // admits.
  rounds: null,
  // …and a bracket has no pool stage, so no structural settings to own either (ADR
  // 20260808). `null` is the only value the server's `single-elim` arm admits.
  drawOwnership: null,
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
  pools: [],
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
    // near half of the round trip the read shape's `qualifiers_per_pool` exists for.
    qualifiersPerPool: event.qualifiersPerPool,
    // …and the round count the same way, the near half of the round trip the read shape's
    // `rounds` exists for.
    rounds: event.rounds,
    // The ownership record the SERVER sent back, straight onto the tab — the near half of
    // the round trip `draw_structure` exists for, and what makes a setting a director took
    // last week still read `Yours` when they reopen the event.
    drawOwnership: event.drawOwnership,
    maxPlayers: event.maxPlayers,
    entryFee: event.entryFee,
    timezone: event.timezone,
    slot: event.slot,
    match: event.match,
    predicates: event.predicates,
    // Every stored pool, **cited by the id the server minted** (`keepPools`,
    // `data/pool-entries`) — the "change nothing about the set" diff the organizer then
    // edits by adding to it, removing from it, or re-wording it. Seeding it any other way
    // would be seeding a removal: under an id-keyed diff, a stored pool no entry cites is
    // deleted, and its fixtures with it.
    //
    // …and **in POSITION order** (`poolsInOrder`, `data/helpers`), which is the ONE place
    // the pools editor's order is decided. From here on the field array's order IS the
    // order: the cards render in it, `addPool` appends to the end of it, and — the reason
    // it has to be settled here rather than at render time — a save serializes it, from
    // which the server re-derives each pool's position (`poolEntriesToApi`, `data/api`).
    // The sort is the last thing that reads `position`; an entry does not carry one,
    // because a client does not assign one.
    //
    // So sorting for *display* alone would be a bug with a delay on it: the director
    // would see A, B, C, save, and get back whatever order the array was really in. The
    // list they were looking at has to be the list that goes on the wire.
    pools: keepPools(poolsInOrder(event.pools)),
  }
}

/**
 * The form's values **as the save sends them** — the other half of the rule the resolver
 * stops short of (ADR 20260808, #1320).
 *
 * The server's `rr-then-ko` arm requires `qualifiers_per_pool` and always has: there is no
 * absent state for it, and a `null` on that arm is a 422. So a count the director does not
 * own still has to be a number on the wire — **automatic means "send the derived one", not
 * "send nothing"**. This is where that number is supplied, and it is called on the way out
 * of the editor so the invariant reads in one place: *no `rr-then-ko` save leaves this
 * client without a count `qualifiersPerPoolSchema` accepts.* The resolver refuses a count
 * the director broke; this supplies the one they never gave.
 *
 * **The number comes from `deriveDrawStructure` and is never recomputed here.** It is the
 * same call the Draw structure tab renders from, with the same eight inputs, so the count
 * that is saved is the count the row was showing — the whole point of the tab. A second
 * `ceil(8 / poolCount)` written beside it would be a second derivation with no vector
 * holding it to the Python twin (`data/draw-structure`).
 *
 * ⚠️ **A stored count is left alone**, and that narrowing is deliberate. When the mode is
 * automatic the stored K is the director's remembered number and — more to the point —
 * **the count the event's bracket was cut for**: the server freezes the configuration the
 * draw was dealt from and compares `qualifiers_per_pool` inside it
 * (`_enforce_draw_settings_frozen`, `api/app/tournament_events.py`). Rewriting a cut
 * event's K to a derived one behind the director's back would 409 a save of something else
 * entirely, naming a number they never touched — #1320's own bug, reintroduced by its fix.
 * The pool size row is not frozen, so a derived count really does move under a cut event.
 * Closing the gap between a displayed count and the count the API cuts from is the
 * **server's** derivation to do (`api/app/schemas/tournament.py`, chores 4a/5c); it is not
 * this client's to paper over with a silent write.
 */
export function withSuppliedQualifiers(values: EventFormValues): EventFormValues {
  // The three count-less arms send no `qualifiers_per_pool` at all (`drawSettingsToApi`,
  // `data/api`), so there is nothing to supply and a stale value is already dropped.
  if (values.drawType !== 'rr-then-ko') return values
  const ownership = values.drawOwnership ?? everySettingAutomatic()
  // The director's own count, already judged by the resolver above. Theirs to be right or
  // wrong about, never ours to replace.
  if (ownership.qualifiersMode === 'manual') return values
  // A count the server would take: the remembered one, or the one the draw was cut for.
  if (qualifiersPerPoolSchema.safeParse(values.qualifiersPerPool).success) return values
  const { qualifiersPerPool } = deriveDrawStructure({
    // Exactly the arguments `DrawStructureSection` derives from, read off the same live
    // form. The tab reads the cap through the draft and the pools through this very field.
    previewFieldSize: previewFieldSize(values.maxPlayers),
    poolReservationCount: values.pools.length,
    poolCountMode: ownership.poolCountMode,
    manualPoolCount: ownership.manualPoolCount,
    poolSizeMode: ownership.poolSizeMode,
    manualPoolSize: ownership.manualPoolSize,
    qualifiersMode: ownership.qualifiersMode,
    manualQualifiers: values.qualifiersPerPool,
  })
  return { ...values, qualifiersPerPool }
}

/**
 * The first tab holding something the resolver rejected, in the order the tabs are
 * laid out — where a refused save must take the organizer. `null` when the form is
 * clean.
 *
 * A message on a tab you cannot see is indistinguishable from a button that does
 * nothing, which is exactly what Save looked like before this existed.
 *
 * Basics before Eligibility before Table pools before Draw structure, deliberately: that
 * is the order the tabs are in, and with more than one broken, the name is the field they
 * are most likely to have simply not filled in — landing on a *later* tab would leave the
 * empty name behind them, unseen.
 */
export function firstInvalidSection(
  errors: FieldErrors<EventFormValues>,
): EventSection | null {
  // `rounds` lives on Basics beside the draw type that decides whether it is asked at all,
  // so a refused swiss save opens the tab holding the empty box. `qualifiersPerPool` used
  // to be asked here too, and is asked LAST now — it moved tabs in chore 3e, and this map
  // has to move with it or a refused two-stage save lands on a tab with nothing red on it.
  if (
    errors.name ||
    errors.rounds ||
    errors.maxPlayers ||
    errors.entryFee ||
    errors.timezone
  )
    return 'basics'
  if (errors.predicates) return 'eligibility'
  // A pool with a cleared name (`poolNameSchema`). RHF reports it per row
  // (`errors.pools[2].name`) *and* sets the array key, so the truthiness of `pools` is
  // the whole question here — which row it is, the card itself says, in red, under the
  // box. Match settings has no arm: every control on it is a closed picker.
  if (errors.pools) return 'pools'
  // The FIFTH tab, so it is asked last (`SECTIONS` + `DRAW_STRUCTURE_SECTION`,
  // `./event-editor`). Two fields land here, and they are reached very differently:
  //
  // - **`qualifiersPerPool`** is the one a director walks into. K is required on every
  //   `rr-then-ko` event, its box is on this tab, and emptying that box is a refused save
  //   — which has to open the tab holding the box, with the red under it.
  // - **`drawOwnership`** is insurance. The manual boxes parse each keystroke
  //   (`acceptedManualEntry`, `data/draw-ownership`) and never accept a value
  //   `drawOwnershipSchema` would reject, so this arm exists for the day something else
  //   writes the record.
  if (errors.qualifiersPerPool || errors.drawOwnership) return 'draw-structure'
  return null
}
