import { z } from 'zod'
import type { FieldErrors } from 'react-hook-form'

import { drawTypeSchema } from '../data/draw-types'
import {
  entryFeeSchema,
  maxPlayersSchema,
  nameSchema,
  poolNameSchema,
  type EventSection,
} from '../data/event-validation'
import { browserTimezone } from '../data/helpers'
import { PRED_OPS_BY_TYPE, type PredicateOp } from '../data/options'
import { eligibilityIssues } from '../data/predicate-validation'
import type {
  Pool,
  Predicate,
  PredicateValue,
  TournamentEvent,
} from '../data/types'

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

/** A table pool — its name, its window, and the tables it reserves. Typed as the
 * domain's `Pool` for the same reason `predicateSchema` is: the pool cards hand a
 * form field back as a `Pool`, and a mirror that is merely *similar* would need a
 * cast to cross that seam.
 *
 * `name` carries the server's floor (`poolNameSchema`, `data/event-validation`) — the
 * one field of a pool the organizer can *clear*. Its `id` is minted and boxless, so it
 * is left alone: see the note on `poolNameSchema`. */
const poolSchema: z.ZodType<Pool, Pool> = z.object({
  id: z.string(),
  name: poolNameSchema,
  slot: slotSchema,
  tableIds: z.array(z.string()),
})

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
 *   blank (`poolNameSchema`). The pools editor mints the id and the default name, so
 *   only the *box* could ever author one — and it did.
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
  pools: z.array(poolSchema),
})

// The schema mirrors the domain types (`Predicate`, `Pool`) so the nested-array
// sub-forms are validated by this one resolver; the section code that rebuilds a
// clean `Predicate`/`Pool` from each `useFieldArray` field is the compile-time
// check that the mirror holds.
export type EventFormValues = z.infer<typeof eventSchema>

const EMPTY_FORM_VALUES: EventFormValues = {
  name: '',
  format: 'singles',
  drawType: 'single-elim',
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
    maxPlayers: event.maxPlayers,
    entryFee: event.entryFee,
    timezone: event.timezone,
    slot: event.slot,
    match: event.match,
    predicates: event.predicates,
    pools: event.pools,
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
 * Basics before Eligibility before Table pools, deliberately: that is the order the
 * tabs are in, and with more than one broken, the name is the field they are most
 * likely to have simply not filled in — landing on a *later* tab would leave the empty
 * name behind them, unseen.
 */
export function firstInvalidSection(
  errors: FieldErrors<EventFormValues>,
): EventSection | null {
  if (errors.name || errors.maxPlayers || errors.entryFee || errors.timezone)
    return 'basics'
  if (errors.predicates) return 'eligibility'
  // A pool with a cleared name (`poolNameSchema`). RHF reports it per row
  // (`errors.pools[2].name`) *and* sets the array key, so the truthiness of `pools` is
  // the whole question here — which row it is, the card itself says, in red, under the
  // box. Match settings has no arm: every control on it is a closed picker.
  if (errors.pools) return 'pools'
  return null
}
