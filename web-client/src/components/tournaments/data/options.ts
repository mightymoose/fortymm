// Select/segmented-control option lists and the eligibility predicate schema.
// Shared by the event editor, the event cards, and the predicate formatter.

import type { EventFormat, MatchLength, TournamentStatus } from './types'

/** The label an option list gives `value`, or `fallback` when the list has no
 * entry for it. A viewer reads the option's label ("Round robin"), never the enum
 * key it is stored under ("round-robin"), so every surface that renders a stored
 * value needs this lookup — it was hand-rolled five times before it lived here.
 *
 * The list need not be a hardcoded one: the draw-type catalogue arrives from the
 * server (`./draw-types`) and is looked up through exactly this function, so a stored
 * draw type is labelled by the same rule as a stored format.
 *
 * The fallback is an argument rather than a default because the two policies in
 * use differ deliberately: a read-only `Field` passes `null`, so an unknown key
 * renders as `ReadOnlyValue`'s em-dash; a card passes the raw value, so it shows
 * *something* rather than blanking a whole row. */
export function labelFor<V, F>(
  options: readonly { value: V; label: string }[],
  value: V,
  fallback: F,
): string | F {
  return options.find((o) => o.value === value)?.label ?? fallback
}

export const FORMAT_OPTIONS: { value: EventFormat; label: string }[] = [
  { value: 'singles', label: 'Singles' },
  { value: 'doubles', label: 'Doubles' },
  { value: 'teams', label: 'Teams' },
]

// ⚠️ There is deliberately **no `DRAW_TYPE_OPTIONS` here**, and there must not be one
// again. The draw-type catalogue is SERVED — the tournament-detail payload's
// `draw_type_catalogue`, parsed by `./draw-types` — because a hardcoded list is a
// second copy of the server's `draw_types` table that has to be kept in agreement by
// hand, and while it drifted a director could pick a format the server cannot plan
// (ADR 20260726). The lists below stay hardcoded because their vocabularies are fixed
// by the wire schema and carry no server-side copy to drift from.

export const MATCH_LENGTH_OPTIONS: { value: MatchLength; label: string }[] = [
  { value: 1, label: 'Bo1' },
  { value: 3, label: 'Bo3' },
  { value: 5, label: 'Bo5' },
  { value: 7, label: 'Bo7' },
]

/** The filter-tab label for each tournament status, **in tab order**.
 *
 * Typed `Record<TournamentStatus, string>` on purpose, exactly as `LIFECYCLE_EDGE`
 * (`./lifecycle`) and `STATUS_META` (`../status-badge`) are: a fifth status added to
 * `TournamentStatus` fails the type check here until it gets a tab. The list this
 * replaced re-typed the four values by hand and dropped `live`, so a status an owner
 * could reach from a button had no tab that found it (#970) — the hand-written union
 * WAS the defect, and deriving the tabs from the enum is what keeps it closed.
 *
 * These are *tab* labels, not pill labels, so this is not `STATUS_META`: the tab reads
 * `Drafts` (a bucket of things) where the pill reads `Draft` (one thing's state).
 *
 * Declaration order is tab order — JavaScript preserves string-key insertion order, so
 * `Object.keys` below yields All · Drafts · Published · Live · Archived. */
export const STATUS_TAB_LABEL: Record<TournamentStatus, string> = {
  draft: 'Drafts',
  published: 'Published',
  live: 'Live',
  archived: 'Archived',
}

/** Every `TournamentStatus`, in tab order — read off the `Record` above rather than
 * re-listed, so there is one place a new status has to be named. The assertion only
 * restores what `Object.keys` erases (it is typed `string[]`); the exhaustiveness is
 * the `Record`'s, and it survives.
 *
 * A non-empty tuple because `z.enum` (`./search`) takes one. */
export const TOURNAMENT_STATUS_KEYS = Object.keys(STATUS_TAB_LABEL) as [
  TournamentStatus,
  ...TournamentStatus[],
]

/** The value a status tab selects: a concrete status, or `all` (the default, which
 * carries no `status` in the URL). */
export type StatusFilter = 'all' | TournamentStatus

/** The tab strip on the tournaments list. Annotated rather than inferred because
 * `Object.keys` returns `string[]`, which would collapse `StatusFilter` to `string`
 * and let an unknown tab value typecheck. */
export const STATUS_FILTER_OPTIONS: {
  value: StatusFilter
  label: string
}[] = [
  { value: 'all', label: 'All' },
  ...TOURNAMENT_STATUS_KEYS.map((status) => ({
    value: status,
    label: STATUS_TAB_LABEL[status],
  })),
]

/** Narrow the raw `string` the `Tabs` widget hands back to a `StatusFilter`, falling
 * back to `all`.
 *
 * A widget's `onValueChange` is a boundary like any other, so it gets a parse rather
 * than a cast (`.claude/rules/parse-at-boundaries.md`) — the same treatment, and the
 * same shape, as `parsePredicateOp` below. Looking the value up in the very list the
 * tabs were rendered from IS the parse: a tab value the strip never offered cannot
 * become the active filter. */
export function parseStatusFilter(raw: string): StatusFilter {
  return STATUS_FILTER_OPTIONS.find((o) => o.value === raw)?.value ?? 'all'
}

/** The kinds of value control a predicate field can take. Only `number` exists
 * today, because only `rating` exists (see `PRED_FIELDS`) — the `enum` and `bool`
 * variants left with the fields that used them (ADR-0783). The indirection stays
 * so the operator table below remains keyed by *type* rather than by field: the
 * next field we can honestly evaluate brings its own type, and its operators land
 * in one place. */
export type PredicateFieldType = 'number'

export interface PredicateFieldSchema {
  label: string
  type: PredicateFieldType
  unit?: string
  placeholder?: string
}

/** The eligibility-rule vocabulary: **one** field, `rating`.
 *
 * A rule may only name a fact we hold about a player (ADR-0783). `age`, `gender`
 * and `club` named nothing — no date of birth, no gender, no club exists anywhere
 * in the system — so the builder was authoring rules that could never be
 * evaluated, under a subtitle that told the player "Players must satisfy every
 * rule to enter". The API now types `Predicate.field` as `Literal["rating"]` and
 * 422s anything else; this list is the client half of that narrowing.
 *
 * And it is a **"Rating"**, not a "USATT rating": what we hold is a Glicko-2
 * league rating. Gating entry on one number while naming another is the same lie
 * in a different suit.
 *
 * Typed `Record<string, …>` rather than `Record<PredicateField, …>` on purpose: a
 * lookup of a field key that is *not* in the vocabulary must stay expressible, so
 * the read-back formatters can guard it (`if (!schema) return EM_DASH`) instead of
 * rendering `undefined.label` at a stale payload. */
export const PRED_FIELDS: Record<string, PredicateFieldSchema> = {
  rating: {
    label: 'Rating',
    type: 'number',
    unit: 'pts',
    placeholder: '1500',
  },
}

/** The operators the builder offers, per field type — and, via `PredicateOp`
 * below, the operators a `Predicate` is *allowed to hold*.
 *
 * `as const satisfies` rather than a plain type annotation: the annotation
 * widened every `value` to `string`, which is what let the domain type say
 * `op: string` and let the client author `op: 'is'` — a payload the API answers
 * with a 422. Frozen literal-side, the table can be read as a type. */
export const PRED_OPS_BY_TYPE = {
  number: [
    { value: '<', label: 'is less than' },
    { value: '<=', label: 'is at most' },
    { value: '>', label: 'is greater than' },
    { value: '>=', label: 'is at least' },
    { value: '=', label: 'equals' },
    { value: '!=', label: 'is not' },
    { value: 'between', label: 'is between' },
  ],
} as const satisfies Record<
  PredicateFieldType,
  readonly { value: string; label: string }[]
>

/** Every operator a rule may use — **derived from the table above**, not
 * re-typed beside it. The API's `Predicate.op` is the same seven-member enum and
 * 422s the rest (see `schema.d.ts`), so the two lists that must agree are the
 * one the builder *renders* and the one the client is *allowed to author*: make
 * them one list and they cannot drift. Widening this back to `string` is a
 * compile error in `data/options.test.ts`, and an operator added to the table
 * lands here — and in the `Record` of symbols in `data/helpers.ts` — for free. */
export type PredicateOp =
  (typeof PRED_OPS_BY_TYPE)[PredicateFieldType][number]['value']

/** Narrow the raw `string` a `<select>` hands back to a `PredicateOp`, or `null`
 * when the table for that field type does not offer it.
 *
 * A widget's `onChange` is a boundary like any other — what came back is a
 * string until something *parses* it (`.claude/rules/parse-at-boundaries.md`).
 * Looking it up in the very table the options were rendered from IS the parse:
 * no cast, and a `PredicateOp` that the builder never offered cannot enter a
 * rule. */
export function parsePredicateOp(
  type: PredicateFieldType,
  raw: string,
): PredicateOp | null {
  return PRED_OPS_BY_TYPE[type].find((o) => o.value === raw)?.value ?? null
}
