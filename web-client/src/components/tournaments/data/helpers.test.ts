import {
  daysBetween,
  effectiveDateRange,
  fmtDateRange,
  fmtTimeWindow,
  formatPredicate,
  predicateSentence,
  findPoolConflicts,
  myEntrant,
} from './helpers'
import {
  buildEntrant,
  buildPool,
  buildTournament,
  buildEvent,
} from './seed.factory'
import type { Predicate } from './types'

describe('myEntrant', () => {
  const mine = buildEntrant({
    id: 'entry-me',
    userId: 'u-me',
    username: 'rita.kovac',
  })
  const theirs = buildEntrant({
    id: 'entry-them',
    userId: 'u-2',
    username: 'lee.wong',
  })

  it('finds my own entry — the id a withdrawal is addressed to', () => {
    const event = buildEvent({ entrants: [theirs, mine] })

    expect(myEntrant(event, 'rita.kovac')).toEqual(mine)
  })

  it('is undefined when I am not entered, so the control offers Enter', () => {
    const event = buildEvent({ entrants: [theirs] })

    expect(myEntrant(event, 'rita.kovac')).toBeUndefined()
  })

  it('is undefined for an event nobody has entered', () => {
    expect(myEntrant(buildEvent({ entrants: [] }), 'rita.kovac')).toBeUndefined()
  })

  it('is undefined without a username (no session yet) rather than guessing', () => {
    const event = buildEvent({ entrants: [mine] })

    expect(myEntrant(event, undefined)).toBeUndefined()
    expect(myEntrant(event, null)).toBeUndefined()
  })
})

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

describe('fmtTimeWindow', () => {
  it('joins both bounds with an en dash', () => {
    // U+2013 between the times; U+2014 (EM_DASH) is only the unset marker.
    expect(fmtTimeWindow('09:00', '12:00')).toBe('09:00–12:00')
  })

  it('shows a lone start on its own, with no dangling dash', () => {
    expect(fmtTimeWindow('09:00', '')).toBe('09:00')
  })

  it('shows a lone end on its own, with no leading dash', () => {
    expect(fmtTimeWindow('', '12:00')).toBe('12:00')
  })

  it('renders a wholly unset window as an em-dash', () => {
    expect(fmtTimeWindow('', '')).toBe('—')
    expect(fmtTimeWindow(null, undefined)).toBe('—')
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

  // The chip and the sentence share one vocabulary, so they must agree on the
  // unset case too: an unfinished enum rule reads as the em-dash both use, never
  // as the string "null" that `String(p.value)` used to leak onto the card.
  it('renders an unfinished enum rule as an em-dash, not "null"', () => {
    const p: Predicate = { id: 'p', field: 'gender', op: 'is', value: null }
    expect(formatPredicate(p)).toBe('Gender = —')
    expect(formatPredicate(p)).not.toContain('null')
    expect(predicateSentence(p)).toBe('Gender is —')
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
