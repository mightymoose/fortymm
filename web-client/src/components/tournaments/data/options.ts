// Select/segmented-control option lists and the eligibility predicate schema.
// Shared by the event editor, the event cards, and the predicate formatter.

import type { DrawType, EventFormat, MatchLength } from './types'

/** The label an option list gives `value`, or `fallback` when the list has no
 * entry for it. A viewer reads the option's label ("RR → KO"), never the enum
 * key it is stored under ("rr-then-ko"), so every surface that renders a stored
 * value needs this lookup — it was hand-rolled five times before it lived here.
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

export const DRAW_TYPE_OPTIONS: { value: DrawType; label: string }[] = [
  { value: 'single-elim', label: 'Single elimination' },
  { value: 'double-elim', label: 'Double elimination' },
  { value: 'round-robin', label: 'Round robin' },
  { value: 'rr-then-ko', label: 'RR → KO' },
  { value: 'swiss', label: 'Swiss' },
]

export const MATCH_LENGTH_OPTIONS: { value: MatchLength; label: string }[] = [
  { value: 1, label: 'Bo1' },
  { value: 3, label: 'Bo3' },
  { value: 5, label: 'Bo5' },
  { value: 7, label: 'Bo7' },
]

export const STATUS_FILTER_OPTIONS: {
  value: 'all' | 'published' | 'draft' | 'archived'
  label: string
}[] = [
  { value: 'all', label: 'All' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Drafts' },
  { value: 'archived', label: 'Archived' },
]

export type PredicateFieldType = 'number' | 'enum' | 'bool'

export interface PredicateFieldSchema {
  label: string
  type: PredicateFieldType
  unit?: string
  placeholder?: string
  options?: { value: string; label: string }[]
}

export const PRED_FIELDS: Record<string, PredicateFieldSchema> = {
  age: { label: 'Age', type: 'number', unit: 'yrs', placeholder: '18' },
  rating: {
    label: 'USATT rating',
    type: 'number',
    unit: 'pts',
    placeholder: '1500',
  },
  gender: {
    label: 'Gender',
    type: 'enum',
    options: [
      { value: 'F', label: 'Female' },
      { value: 'M', label: 'Male' },
      { value: 'X', label: 'Non-binary / open' },
    ],
  },
  club: { label: 'Club member', type: 'bool' },
}

export const PRED_OPS_BY_TYPE: Record<
  PredicateFieldType,
  { value: string; label: string }[]
> = {
  number: [
    { value: '<', label: 'is less than' },
    { value: '<=', label: 'is at most' },
    { value: '>', label: 'is greater than' },
    { value: '>=', label: 'is at least' },
    { value: '=', label: 'equals' },
    { value: '!=', label: 'is not' },
    { value: 'between', label: 'is between' },
  ],
  enum: [
    { value: 'is', label: 'is' },
    { value: 'isnt', label: 'is not' },
  ],
  bool: [
    { value: 'true', label: 'must be' },
    { value: 'false', label: 'must not be' },
  ],
}
