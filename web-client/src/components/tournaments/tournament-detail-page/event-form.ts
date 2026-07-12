import { z } from 'zod'

import type { TournamentEvent } from '../data/types'

const NAME_MAX = 255

/** A `YYYY-MM-DD` date with `HH:MM` start/end — the shape both an event and a
 * pool carry (mirrors `Slot` in `data/types`). */
const slotSchema = z.object({
  date: z.string(),
  start: z.string(),
  end: z.string(),
})

/** An eligibility predicate's value: a number (most fields), an enum key
 * (gender), a boolean (club), a `[min, max]` pair for `between`, or unset —
 * mirrors `PredicateValue` in `data/types`. */
const predicateValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.tuple([z.number().nullable(), z.number().nullable()]),
  z.null(),
])

/** One ANDed eligibility rule — `field`/`operator`/`value`, plus the stable id
 * the row is keyed on. Mirrors `Predicate` in `data/types`, so the nested-array
 * sub-form is validated by the same resolver as the scalar fields (chore 1e). */
const predicateSchema = z.object({
  id: z.string(),
  field: z.enum(['age', 'rating', 'gender', 'club']),
  op: z.string(),
  value: predicateValueSchema,
})

/** A table pool — its name, its window, and the tables it reserves. Mirrors
 * `Pool` in `data/types`. */
const poolSchema = z.object({
  id: z.string(),
  name: z.string(),
  slot: slotSchema,
  tableIds: z.array(z.string()),
})

// Mirrors the server's event constraints so a bad value is an inline message
// rather than a bare 4xx (ADR-0935):
//   • name — `VARCHAR(255)`, `NOT NULL` → trimmed, 1..255.
//   • maxPlayers — nullable "no cap"; when present a positive integer. A blank
//     field is `null`, never `0`/`NaN`.
//   • entryFee — required and non-negative; `0` is a free event. A blank field
//     reaches the resolver as `NaN` and is a required error.
//   • predicates / pools — the nested-array sub-forms, each validated against
//     its own item shape (chore 1e). They are driven by `useFieldArray` on this
//     same form, so add/edit/remove flow through one form state.
export const eventSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Event name is required.' })
    .max(NAME_MAX, {
      message: `Event name must be ${NAME_MAX} characters or fewer.`,
    }),
  format: z.enum(['singles', 'doubles', 'teams']),
  drawType: z.enum([
    'single-elim',
    'double-elim',
    'round-robin',
    'rr-then-ko',
    'swiss',
  ]),
  maxPlayers: z
    .number()
    .int({ message: 'Player limit must be a whole number.' })
    .positive({ message: 'Player limit must be at least 1, or blank for no cap.' })
    .nullable(),
  entryFee: z.union([z.nan(), z.number()]).superRefine((v, ctx) => {
    if (Number.isNaN(v)) {
      ctx.addIssue({ code: 'custom', message: 'Entry fee is required.' })
      return
    }
    if (v < 0) {
      ctx.addIssue({ code: 'custom', message: 'Entry fee can’t be negative.' })
    }
  }),
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
  predicates: z.array(predicateSchema),
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
  maxPlayers: null,
  entryFee: NaN,
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
    slot: event.slot,
    match: event.match,
    predicates: event.predicates,
    pools: event.pools,
  }
}
