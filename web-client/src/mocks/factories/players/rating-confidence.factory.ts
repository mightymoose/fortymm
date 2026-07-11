import type { components } from '@/api/schema'

type RatingConfidence = components['schemas']['RatingConfidence']

/**
 * How settled a player's rating is (`CONTEXT.md` § *Rating confidence*).
 *
 * The default is a **settled** rating: an RD of 69.4 — below the API's
 * firming-up floor of 90 — around the bundle's default rating of 1687, which
 * puts the 95% interval (`rating ± 1.96 · RD`) at **1551–1823**. Those three
 * numbers are coherent on purpose: the interval is the card's one rigorous
 * statement, and a fixture whose interval didn't follow from its deviation would
 * let a card that computed the interval itself (it must not — the API sends it)
 * pass.
 *
 * Note what is NOT here and never will be: a confidence **percentage**. There is
 * no such number — it would be an arbitrary rescaling of RD onto a 0–100 axis
 * (`CONTEXT.md`). A fixture is the easiest place to accidentally invent one, so:
 * don't.
 */
export function buildRatingConfidence(
  overrides: Partial<RatingConfidence> = {},
): RatingConfidence {
  return {
    level: 'settled',
    deviation: 69.4,
    volatility: 0.0592,
    interval: { low: 1551, high: 1823 },
    ...overrides,
  }
}

/**
 * A brand-new (or long-idle) player: the system has no idea where they belong.
 * RD 210 is well past the API's provisional floor of 160, and the interval it
 * implies is *enormous* — 1088 to 1912 — which is the honest thing the card is
 * for.
 */
export function buildProvisionalConfidence(
  overrides: Partial<RatingConfidence> = {},
): RatingConfidence {
  return buildRatingConfidence({
    level: 'provisional',
    deviation: 210,
    volatility: 0.06,
    interval: { low: 1088, high: 1912 },
    ...overrides,
  })
}

/** The middle level: RD 120 — under the provisional floor (160), over the
 * settled one (90). Still moving, but not wildly. */
export function buildFirmingUpConfidence(
  overrides: Partial<RatingConfidence> = {},
): RatingConfidence {
  return buildRatingConfidence({
    level: 'firming_up',
    deviation: 120,
    volatility: 0.0605,
    interval: { low: 1452, high: 1922 },
    ...overrides,
  })
}
