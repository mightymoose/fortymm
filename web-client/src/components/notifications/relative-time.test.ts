import { relativeTime } from './relative-time'

const NOW = new Date('2026-06-17T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('shows "now" for the last 45 seconds', () => {
    expect(relativeTime(ago(0), NOW)).toBe('now')
    expect(relativeTime(ago(44 * SECOND), NOW)).toBe('now')
  })

  it('treats a slightly-future timestamp (clock skew) as now', () => {
    expect(relativeTime(new Date(NOW.getTime() + 5 * SECOND).toISOString(), NOW)).toBe(
      'now',
    )
  })

  it('counts minutes under an hour', () => {
    expect(relativeTime(ago(2 * MINUTE), NOW)).toBe('2m')
    expect(relativeTime(ago(59 * MINUTE), NOW)).toBe('59m')
  })

  it('counts hours under a day', () => {
    expect(relativeTime(ago(HOUR), NOW)).toBe('1h')
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe('23h')
  })

  it('says "Yesterday" for exactly one day, then counts days', () => {
    expect(relativeTime(ago(DAY), NOW)).toBe('Yesterday')
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d')
    expect(relativeTime(ago(6 * DAY), NOW)).toBe('6d')
  })

  it('counts weeks up to a month', () => {
    expect(relativeTime(ago(7 * DAY), NOW)).toBe('1w')
    expect(relativeTime(ago(28 * DAY), NOW)).toBe('4w')
  })

  it('falls back to a short date past a month', () => {
    // ~3 months earlier — no longer a relative bucket.
    expect(relativeTime('2026-03-10T12:00:00.000Z', NOW)).toBe('Mar 10')
  })
})
