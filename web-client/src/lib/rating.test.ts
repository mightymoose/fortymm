import { formatRatingDelta, formatRatingDeltaAria } from './rating'

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
