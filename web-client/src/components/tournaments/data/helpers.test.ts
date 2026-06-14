import {
  daysBetween,
  effectiveDateRange,
  fmtDateRange,
  formatPredicate,
  findPoolConflicts,
} from './helpers'
import { buildPool, buildTournament, buildEvent } from './seed.factory'
import type { Predicate } from './types'

describe('fmtDateRange', () => {
  it('collapses a same-month span to one month label', () => {
    expect(fmtDateRange('2026-06-13', '2026-06-14')).toBe('Jun 13–14, 2026')
  })

  it('spans months in full', () => {
    expect(fmtDateRange('2026-06-30', '2026-07-01')).toBe('Jun 30 – Jul 1, 2026')
  })

  it('returns a single date when the days are equal', () => {
    expect(fmtDateRange('2026-06-13', '2026-06-13')).toBe('Jun 13, 2026')
  })
})

describe('daysBetween', () => {
  it('counts inclusively', () => {
    expect(daysBetween('2026-06-13', '2026-06-14')).toBe(2)
  })

  it('floors at one day', () => {
    expect(daysBetween('2026-06-13', '2026-06-13')).toBe(1)
  })
})

describe('effectiveDateRange', () => {
  it('derives the span from event slots when events exist', () => {
    const t = buildTournament({
      startDate: '2030-01-01',
      endDate: '2030-01-01',
      events: [
        buildEvent({ slot: { date: '2026-06-14', start: '09:00', end: '12:00' } }),
        buildEvent({ slot: { date: '2026-06-13', start: '09:00', end: '12:00' } }),
      ],
    })
    expect(effectiveDateRange(t)).toEqual({ start: '2026-06-13', end: '2026-06-14' })
  })

  it('falls back to the seeded dates with no events', () => {
    const t = buildTournament({
      startDate: '2026-08-22',
      endDate: '2026-08-23',
      events: [],
    })
    expect(effectiveDateRange(t)).toEqual({ start: '2026-08-22', end: '2026-08-23' })
  })
})

describe('formatPredicate', () => {
  it('labels a numeric less-than rule', () => {
    const p: Predicate = { id: 'p', field: 'rating', op: '<', value: 1500 }
    expect(formatPredicate(p)).toBe('USATT rating < 1500')
  })

  it('labels an enum equality rule with the option label', () => {
    const p: Predicate = { id: 'p', field: 'gender', op: 'is', value: 'F' }
    expect(formatPredicate(p)).toBe('Gender = Female')
  })

  it('labels a between rule with the range', () => {
    const p: Predicate = { id: 'p', field: 'age', op: 'between', value: [13, 17] }
    expect(formatPredicate(p)).toBe('Age in [13–17]')
  })
})

describe('findPoolConflicts', () => {
  it('flags a table shared by two overlapping same-day pools', () => {
    const conflicts = findPoolConflicts([
      buildPool({
        name: 'Pool A',
        slot: { date: '2026-06-13', start: '09:00', end: '12:00' },
        tableIds: ['t1', 't2'],
      }),
      buildPool({
        name: 'Pool B',
        slot: { date: '2026-06-13', start: '11:00', end: '14:00' },
        tableIds: ['t2', 't3'],
      }),
    ])
    expect(conflicts).toEqual([{ table: 'T2', poolA: 'Pool A', poolB: 'Pool B' }])
  })

  it('ignores pools that do not overlap in time', () => {
    const conflicts = findPoolConflicts([
      buildPool({ slot: { date: '2026-06-13', start: '09:00', end: '11:00' }, tableIds: ['t1'] }),
      buildPool({ slot: { date: '2026-06-13', start: '11:00', end: '13:00' }, tableIds: ['t1'] }),
    ])
    expect(conflicts).toEqual([])
  })

  it('ignores pools on different days', () => {
    const conflicts = findPoolConflicts([
      buildPool({ slot: { date: '2026-06-13', start: '09:00', end: '12:00' }, tableIds: ['t1'] }),
      buildPool({ slot: { date: '2026-06-14', start: '09:00', end: '12:00' }, tableIds: ['t1'] }),
    ])
    expect(conflicts).toEqual([])
  })
})
