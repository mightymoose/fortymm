// The dashboard prototype's search params on Home: which option, and which
// made-up data in place of the account's own.
export const VARIANTS = ['a', 'b', 'c'] as const
export type Variant = (typeof VARIANTS)[number]

export const SAMPLES = ['busy', 'new', 'guest'] as const
export type Sample = (typeof SAMPLES)[number]
