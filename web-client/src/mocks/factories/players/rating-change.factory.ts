import type { components } from '@/api/schema'

type RatingChange = components['schemas']['RatingChange']

/**
 * A rating move from a single completed **rated** match. `null` — never a zero
 * delta — is what the API sends when there is no such match, which is why both
 * the hero's Δ chip and a match row's Δ column key off the field's presence
 * rather than off a number.
 *
 * Lives on its own so both the profile bundle (`rating_delta`) and a match row
 * (`rating_change`) can build one without their factories importing each other.
 */
export function buildRatingChange(
  overrides: Partial<RatingChange> = {},
): RatingChange {
  return { before: 1675, after: 1687, delta: 12, ...overrides }
}
