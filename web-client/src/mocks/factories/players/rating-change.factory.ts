import type { components } from '@/api/schema'

type RatingChange = components['schemas']['RatingChange']

/**
 * What one completed **rated** match did to a player's rating.
 *
 * `delta` is **computed here, never passed in** — exactly as the API computes it
 * (a Pydantic `computed_field` off `before`/`after`, not a stored column). That
 * is not tidiness: it makes the phantom of #952 — `{ before: null, delta: -232 }`,
 * "you lost 232 points of a rating you never had" — *unconstructible from this
 * factory*. A mock that can produce the lie is how the lie ships.
 *
 * So there are exactly two shapes a caller can build:
 *
 * - **moved** — `before` is a number, and `delta` is the difference
 *   (`1675 → 1687`, `+12`);
 * - **established** — `before` is `null`, and so `delta` is `null` too: the
 *   player's first rated match *gave* them a rating rather than moving one. Use
 *   `buildEstablishedRatingChange` and say it out loud.
 *
 * (A null `RatingChange` *itself* is a third, different thing: the match moved no
 * rating at all — `rating_change: null` on the row, not this factory.)
 *
 * Lives on its own so both the profile bundle (`rating_delta`) and a match row
 * (`rating_change`) can build one without their factories importing each other.
 */
export function buildRatingChange(
  overrides: Partial<Omit<RatingChange, 'delta'>> = {},
): RatingChange {
  const { before = 1675, after = 1687 } = overrides
  return { before, after, delta: before === null ? null : after - before }
}

/**
 * A player's **first** rated match: Unrated going in, 1268 coming out. `before`
 * and `delta` are both null — nothing moved, a rating came into existence, and
 * the surfaces read `Unrated → 1268` (match detail) or `—` (every Δ column).
 *
 * The default `after` is deliberately **not 1500**: the league-join seed is the
 * very number the bug printed, so a fixture built on it would make "never shows a
 * 1500" a tautology instead of an assertion.
 */
export function buildEstablishedRatingChange(
  overrides: Partial<Omit<RatingChange, 'delta' | 'before'>> = {},
): RatingChange {
  return buildRatingChange({ before: null, after: 1268, ...overrides })
}
