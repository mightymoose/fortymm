import { describe, expect, it } from 'vitest'
import { fmtLongDate } from './dates'

describe('fmtLongDate', () => {
  it('formats a date as full weekday, month and day', () => {
    // 2024-01-01 (local) is a Monday.
    expect(fmtLongDate(new Date(2024, 0, 1))).toBe('Monday, January 1')
    expect(fmtLongDate(new Date(2026, 3, 22))).toBe('Wednesday, April 22')
  })

  it('defaults to today', () => {
    expect(fmtLongDate()).toBe(fmtLongDate(new Date()))
  })
})
