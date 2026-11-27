import { CalendarDate } from '@internationalized/date'
import { describe, expect, it } from 'vitest'
import { dateFormat } from './dates.ts'

const us = dateFormat('en-US')
const gb = dateFormat('en-GB')
const april11 = new CalendarDate(2026, 4, 11)

describe('dateFormat', () => {
  it('writes a full date the US way in the US', () => {
    expect(us.formatDate(april11)).toBe('Saturday, April 11, 2026')
  })

  it('writes a full date the British way in Britain', () => {
    expect(gb.formatDate(april11)).toBe('Saturday, 11 April 2026')
  })

  it('reads numbers month first in the US', () => {
    expect(us.parseDate('4/11/2026')).toEqual(april11)
  })

  it('reads numbers day first in Britain', () => {
    expect(gb.parseDate('11/4/2026')).toEqual(april11)
  })

  it('reads ISO dates anywhere', () => {
    expect(us.parseDate('2026-04-11')).toEqual(april11)
  })

  it('reads the full date it writes', () => {
    expect(us.parseDate('Saturday, April 11, 2026')).toEqual(april11)
  })

  it('reads a month name before the day', () => {
    expect(gb.parseDate('April 11 2026')).toEqual(april11)
  })

  it('reads a short month name and an ordinal', () => {
    expect(us.parseDate('11th Apr 2026')).toEqual(april11)
  })

  it('does not read a day that does not exist', () => {
    expect(us.parseDate('April 31, 2026')).toBeNull()
  })

  it('does not read text that is not a date', () => {
    expect(us.parseDate('next Saturday')).toBeNull()
  })
})
