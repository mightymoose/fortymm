import type { MatchRecord } from './sampleMatches'

export const VARIANTS = ['a', 'b', 'c'] as const
export type Variant = (typeof VARIANTS)[number]

// A route's `?variant=`. With none, or one that isn't an option, the page
// shows option a.
export function parseVariant(search: Record<string, unknown>): { variant?: Variant } {
  const value = search.variant
  return VARIANTS.includes(value as Variant) ? { variant: value as Variant } : {}
}

export const LIST_LABELS: Record<Variant, string> = { a: 'Rows', b: 'Table', c: 'Cards' }
export const DETAIL_LABELS: Record<Variant, string> = { a: 'Scoreboard', b: 'Card', c: 'Sign-off' }

export const vsLabel = (match: MatchRecord) => `${match.players[0].name} vs ${match.players[1].name}`

