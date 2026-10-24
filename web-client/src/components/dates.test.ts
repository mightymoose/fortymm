import { describe, expect, it } from 'vitest'
import { dateFromIso, isoDate, longDate, parseDate } from './dates'

const read = (text: string) => {
  const date = parseDate(text, 2026)
  return date && isoDate(date)
}

describe('parseDate', () => {
  it.each([
    ['11 April 2026', '2026-04-11'],
    ['Sat 11 Apr', '2026-04-11'],
    ['Saturday 11 April 2026', '2026-04-11'],
    ['April 11 2026', '2026-04-11'],
    ['April 11th, 2026', '2026-04-11'],
    ['11/4/2026', '2026-04-11'],
    ['11.4.26', '2026-04-11'],
    ['11-4', '2026-04-11'],
    ['2026-04-11', '2026-04-11'],
    ['3 May 27', '2027-05-03'],
  ])('reads %s', (text, iso) => {
    expect(read(text)).toBe(iso)
  })

  it('takes the fallback year when none is typed', () => {
    expect(isoDate(parseDate('11 Apr', 2027)!)).toBe('2027-04-11')
  })

  it.each(['31/2/2026', '2026-13-01', 'next Tuesday', 'April'])(
    'reads %s as no date',
    (text) => {
      expect(read(text)).toBeNull()
    },
  )
})

describe('longDate', () => {
  it('writes the date in full', () => {
    expect(longDate(dateFromIso('2026-04-11'))).toBe('Saturday 11 April 2026')
  })
})
