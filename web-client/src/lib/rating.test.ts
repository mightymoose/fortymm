import { formatRating, formatRatingDelta, formatRatingDeltaAria } from './rating'

describe('formatRating', () => {
  it('rounds to whole rating points', () => {
    expect(formatRating(1687.4)).toBe('1687')
    expect(formatRating(1686.6)).toBe('1687')
  })

  it('prints an em dash — NEVER a 0 — for a rating that is not there', () => {
    // Holding no rating on a ladder and being rated zero on it are different
    // facts. A "0" would say the player is the worst on it.
    expect(formatRating(null)).toBe('—')
    expect(formatRating(undefined)).toBe('—')
    expect(formatRating(null)).not.toBe('0')
  })

  it('is unsigned — a rating is not a delta', () => {
    // `formatRatingDelta` prints "+12"; a rating is just "1687".
    expect(formatRating(1687)).toBe('1687')
    expect(formatRating(1687)).not.toContain('+')
  })
})

describe('formatRatingDelta', () => {
  it('signs and rounds a gain', () => {
    expect(formatRatingDelta(12.4)).toBe('+12')
  })

  it('rounds a loss without an extra sign', () => {
    expect(formatRatingDelta(-12.4)).toBe('-12')
  })

  it('renders a zero move without a sign', () => {
    expect(formatRatingDelta(0)).toBe('0')
  })
})

describe('formatRatingDeltaAria', () => {
  it('spells out a gain', () => {
    expect(formatRatingDeltaAria(8.2)).toBe('Gained 8 rating')
  })

  it('spells out a loss as a positive magnitude', () => {
    expect(formatRatingDeltaAria(-12.4)).toBe('Lost 12 rating')
  })

  it('reads a zero move as no change', () => {
    expect(formatRatingDeltaAria(0.2)).toBe('No rating change')
  })
})
