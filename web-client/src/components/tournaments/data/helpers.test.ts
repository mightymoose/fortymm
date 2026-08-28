import { afterEach, vi } from 'vitest'

import {
  blankAddress,
  browserTimezone,
  conjoinWithAnd,
  daysBetween,
  emptyEvent,
  emptyTournament,
  fmtDateRange,
  fmtTimeWindow,
  fmtVenueLine,
  formatPredicate,
  hasVenue,
  predicateSentence,
  findReservationConflicts,
  isUnrated,
  myEntrant,
} from './helpers'
import {
  buildAddress,
  buildEntrant,
  buildReservation,
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

describe('isUnrated', () => {
  it('is true when the server sent no rating — the entrant holds none on this ladder', () => {
    expect(isUnrated(buildEntrant({ rating: null }))).toBe(true)
  })

  it('is false for a rated entrant', () => {
    expect(isUnrated(buildEntrant({ rating: 1450 }))).toBe(false)
  })

  it('reads the SERVER’s verdict — a 1500 is a rating, not the "unrated" default', () => {
    // ⚠️ ADR-0783's trap, pinned. A brand-new player is *seeded* 1500 at sign-up,
    // so "unrated" is emphatically not "rating_value is null" and not "rating ===
    // 1500". The server resolves it (`is_rated_member()`) and sends `null`; this
    // predicate reads that answer and nothing else. Re-deriving it here from the
    // number would refuse every beginner from the beginners' event — the exact harm
    // the decision exists to prevent.
    expect(isUnrated(buildEntrant({ rating: 1500 }))).toBe(false)
  })

  it('treats a rating of 0 as a rating — a bad one, not an absent one', () => {
    expect(isUnrated(buildEntrant({ rating: 0 }))).toBe(false)
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

// Every address part is optional, so every separator in this line is a JOIN
// between two present values — never a literal in a template. The old template
// form printed its punctuation regardless, so a venue-less tournament read as a
// bare "· ," (#994). Each case below names the punctuation that must NOT appear.
describe('fmtVenueLine', () => {
  it('joins venue, city, and region when all three are present', () => {
    expect(fmtVenueLine(buildAddress())).toBe('Berkeley TT Club · Berkeley, CA')
  })

  it('shows a lone venue with no trailing dot or comma', () => {
    const line = fmtVenueLine(buildAddress({ city: '', region: '' }))

    expect(line).toBe('Berkeley TT Club')
    expect(line).not.toContain('·')
    expect(line).not.toContain(',')
  })

  it('shows a lone city and region with no leading dot', () => {
    const line = fmtVenueLine(buildAddress({ venue: '' }))

    expect(line).toBe('Berkeley, CA')
    expect(line).not.toContain('·')
  })

  it('shows a venue and city with no trailing comma when the region is blank', () => {
    const line = fmtVenueLine(buildAddress({ region: '' }))

    expect(line).toBe('Berkeley TT Club · Berkeley')
    expect(line).not.toContain(',')
  })

  it('shows a lone region with no leading comma', () => {
    expect(fmtVenueLine(buildAddress({ venue: '', city: '' }))).toBe('CA')
  })

  // The bug's headline case: nothing to punctuate, so nothing at all — the
  // empty string is the caller's cue to render NO venue line (no icon, no row).
  it('is empty when every part is blank, rather than a bare "· ,"', () => {
    expect(fmtVenueLine(buildAddress({ venue: '', city: '', region: '' }))).toBe('')
  })

  // A trimmed-to-nothing value is a blank value: a stray space typed into the
  // Venue field must not resurrect the separator it has nothing to separate.
  it('treats whitespace-only parts as blank', () => {
    expect(
      fmtVenueLine(buildAddress({ venue: '  ', city: '\t', region: ' \n ' })),
    ).toBe('')
    expect(fmtVenueLine(buildAddress({ venue: ' ' }))).toBe('Berkeley, CA')
  })

  // A tournament may have NO VENUE at all (CONTEXT.md, "Venue") — announced before
  // the room is booked, or a home game withholding its address. That is a `null`
  // address, and it reaches this same function rather than a second mechanism: the
  // answer is `''`, the caller's existing cue to render no row.
  //
  // The negative assertions are the requirement, not decoration. "Venue TBD"
  // promises a venue is coming, which is false for the withheld case; an em-dash
  // labels a row that exists, and this row must not (#1206).
  it('is empty for a tournament with NO VENUE — never a "TBD" placeholder', () => {
    expect(fmtVenueLine(null)).toBe('')
    expect(fmtVenueLine(undefined)).toBe('')
    expect(fmtVenueLine(null)).not.toContain('TBD')
    expect(fmtVenueLine(null)).not.toContain('—')
  })
})

// The client's copy of the server's `SubmittedAddress` rule: six blank boxes are
// not a venue. A write surface asks this BEFORE deciding whether to send an address
// or `null`, which is what stops a form inventing a venue out of a default country
// the organizer never typed.
describe('hasVenue', () => {
  it('is false for no address at all, and for an all-blank one', () => {
    expect(hasVenue(null)).toBe(false)
    expect(hasVenue(undefined)).toBe(false)
    expect(hasVenue(blankAddress())).toBe(false)
  })

  it('is false when every component is only whitespace', () => {
    expect(hasVenue(blankAddress({ venue: '  ', city: '\t', country: '\n' }))).toBe(
      false,
    )
  })

  it('is true when ANY component holds something — including one nobody sees', () => {
    expect(hasVenue(blankAddress({ venue: 'Berkeley TT Club' }))).toBe(true)
    // The trap this guards: `country` alone is still an address, and the server
    // would geocode it. A form must therefore not default it in unconditionally.
    expect(hasVenue(blankAddress({ country: 'USA' }))).toBe(true)
    expect(hasVenue(blankAddress({ postal: '94703' }))).toBe(true)
  })
})

describe('emptyTournament', () => {
  // NOT six empty strings, and emphatically not a default country: a blank draft
  // has no venue, and the create body must say so (`address: null`). With an
  // all-blank `Address` here, every tournament created from the modal would carry
  // an address the organizer never typed.
  it('starts with NO VENUE at all', () => {
    expect(emptyTournament().address).toBeNull()
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

describe('formatPredicate', () => {
  it('labels a numeric comparison rule', () => {
    const p: Predicate = { id: 'p', field: 'rating', op: '<', value: 1500 }
    expect(formatPredicate(p)).toBe('Rating < 1500')
  })

  // The rating is a Glicko-2 league rating, not a USATT number (ADR-0783): the
  // chip must not name a ladder we do not hold.
  it('names the rating field "Rating", never "USATT rating"', () => {
    const p: Predicate = { id: 'p', field: 'rating', op: '>=', value: 1200 }
    expect(formatPredicate(p)).not.toContain('USATT')
    expect(predicateSentence(p)).not.toContain('USATT')
  })

  it('labels a between rule with the range', () => {
    const p: Predicate = {
      id: 'p',
      field: 'rating',
      op: 'between',
      value: [1200, 2400],
    }
    expect(formatPredicate(p)).toBe('Rating in [1200–2400]')
  })

  // The chip and the sentence share one vocabulary, so they must agree on the
  // unset case too: an unfinished rule reads as the em-dash both use, never as
  // the string "null" that `String(p.value)` used to leak onto the card.
  it('renders an unfinished rule without leaking "null"', () => {
    const p: Predicate = { id: 'p', field: 'rating', op: '<', value: null }
    expect(formatPredicate(p)).toBe('Rating < ?')
    expect(formatPredicate(p)).not.toContain('null')
    expect(predicateSentence(p)).toBe('Rating is less than —')
  })

  // A field the vocabulary does not know (a payload from a schema that is not
  // ours — the three fields ADR-0783 removed would land here) renders as the
  // em-dash rather than `undefined.label`.
  it('renders an unknown field as an em-dash', () => {
    const p = { id: 'p', field: 'gender', op: 'is', value: 'F' } as unknown as Predicate
    expect(formatPredicate(p)).toBe('—')
    expect(predicateSentence(p)).toBe('—')
  })
})

describe('findReservationConflicts', () => {
  it('flags a table shared by two overlapping same-day reservations', () => {
    const conflicts = findReservationConflicts([
      buildReservation({
        name: 'Reservation A',
        slot: { date: '2026-06-13', start: '09:00', end: '12:00' },
        tableIds: ['t1', 't2'],
      }),
      buildReservation({
        name: 'Reservation B',
        slot: { date: '2026-06-13', start: '11:00', end: '14:00' },
        tableIds: ['t2', 't3'],
      }),
    ])
    expect(conflicts).toEqual([
      { table: 'T2', reservationA: 'Reservation A', reservationB: 'Reservation B' },
    ])
  })

  it('ignores reservations that do not overlap in time', () => {
    const conflicts = findReservationConflicts([
      buildReservation({ slot: { date: '2026-06-13', start: '09:00', end: '11:00' }, tableIds: ['t1'] }),
      buildReservation({ slot: { date: '2026-06-13', start: '11:00', end: '13:00' }, tableIds: ['t1'] }),
    ])
    expect(conflicts).toEqual([])
  })

  it('ignores reservations on different days', () => {
    const conflicts = findReservationConflicts([
      buildReservation({ slot: { date: '2026-06-13', start: '09:00', end: '12:00' }, tableIds: ['t1'] }),
      buildReservation({ slot: { date: '2026-06-14', start: '09:00', end: '12:00' }, tableIds: ['t1'] }),
    ])
    expect(conflicts).toEqual([])
  })
})

/** Point `Intl.DateTimeFormat().resolvedOptions().timeZone` at `zone` for the span
 * of a test — the browser's resolved zone is the default a new event pre-fills from
 * (ADR 20260719), and the only way to prove that default *follows the browser* is to
 * move the browser. Restored in `afterEach`. */
function stubBrowserZone(zone: string) {
  const real = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      const fmt = new real(...args)
      const opts = fmt.resolvedOptions()
      vi.spyOn(fmt, 'resolvedOptions').mockReturnValue({ ...opts, timeZone: zone })
      return fmt
    },
  )
}

describe('browserTimezone', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the browser-resolved IANA zone', () => {
    stubBrowserZone('Asia/Tokyo')
    expect(browserTimezone()).toBe('Asia/Tokyo')
  })
})

describe('emptyEvent', () => {
  afterEach(() => vi.restoreAllMocks())

  it("defaults a new event's timezone to the browser's resolved zone", () => {
    stubBrowserZone('Europe/Paris')
    expect(emptyEvent(buildTournament()).timezone).toBe('Europe/Paris')
  })

  it('mints a new-prefixed id and no draw', () => {
    const event = emptyEvent(buildTournament())
    expect(event.id.startsWith('new')).toBe(true)
    expect(event.fixtures).toEqual([])
  })

  // #1511: the server-derived `dateRange`, not a client re-derivation over the
  // events array.
  it("defaults a new event's date to the tournament's dateRange.start", () => {
    const t = buildTournament({
      dateRange: { start: '2026-08-22', end: '2026-08-23' },
    })
    expect(emptyEvent(t).slot.date).toBe('2026-08-22')
  })

  it("defaults a new event's date to today when the tournament has no dateRange (no events yet)", () => {
    const today = new Date().toISOString().slice(0, 10)
    const t = buildTournament({ dateRange: null, events: [] })
    expect(emptyEvent(t).slot.date).toBe(today)
  })
})

describe('conjoinWithAnd', () => {
  it('joins with commas and a trailing "and": A, B and C', () => {
    expect(conjoinWithAnd(['A', 'B', 'C'])).toBe('A, B and C')
  })

  it('two labels join with a bare "and", no comma', () => {
    expect(conjoinWithAnd(['A', 'B'])).toBe('A and B')
  })

  it('a single label stands alone', () => {
    expect(conjoinWithAnd(['A'])).toBe('A')
  })

  it('an empty list is the empty string, never "undefined"', () => {
    expect(conjoinWithAnd([])).toBe('')
  })
})
