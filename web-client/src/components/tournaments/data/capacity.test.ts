import {
  capacityFillPercent,
  capacityLabel,
  enteredSummary,
  eventCapacity,
} from './capacity'
import { buildEntrants, buildEvent } from './seed.factory'

/** The capacity of an event holding `entered` of `maxPlayers` — stated in the two
 * numbers the reading is about, but built through the real factory, so `entered`
 * stays what the server derives it from (the entrants themselves, ADR-0016) and a
 * case cannot be written that no payload could carry. */
const capacityOf = (entered: number, maxPlayers: number) =>
  eventCapacity(buildEvent({ entrants: buildEntrants(entered), maxPlayers }))

/** The words that capacity renders as — the thing the card actually shows. */
const labelFor = (entered: number, maxPlayers: number) =>
  capacityLabel(capacityOf(entered, maxPlayers))

describe('eventCapacity', () => {
  it('counts the places left in an event with room', () => {
    expect(capacityOf(6, 16)).toEqual({ state: 'places-left', remaining: 10 })
  })

  it('reads an empty event as entirely open', () => {
    expect(capacityOf(0, 48)).toEqual({ state: 'places-left', remaining: 48 })
  })

  // THE BOUNDARY. `entered === maxPlayers` is where "places left" stops being a
  // number: it is not a remainder of zero, it is a different fact. The sum type is
  // what makes that unsayable — `full` carries no `remaining` to be zero.
  it('reads an exactly-full event as FULL, not as a remainder of zero', () => {
    expect(capacityOf(16, 16)).toEqual({ state: 'full' })
  })

  // THE OTHER BOUNDARY, and the representable one people forget: a director may
  // lower `max_players` under a field that has already formed — the server's guard
  // is `>=` precisely because it does not evict anybody — so `entered > maxPlayers`
  // is a payload the client really can receive. `maxPlayers - entered` is negative
  // there, and "-3 places left" is not a number of places.
  it('reads an OVER-full event as full — never as a negative remainder', () => {
    expect(capacityOf(19, 16)).toEqual({ state: 'full' })
  })
})

describe('capacityLabel', () => {
  it('says how many places are left', () => {
    expect(labelFor(6, 16)).toBe('10 places left')
  })

  // The last free place is the copy a player is most likely to be reading.
  it('says "1 place left" — singular — for the last place', () => {
    expect(labelFor(15, 16)).toBe('1 place left')
  })

  it('says a full event is full', () => {
    expect(labelFor(16, 16)).toBe('Full')
  })

  it('says an over-full event is full, with no negative anywhere in it', () => {
    const label = labelFor(19, 16)
    expect(label).toBe('Full')
    expect(label).not.toContain('-')
  })
})

describe('enteredSummary', () => {
  // What a screen reader gets instead of "12 slash 64", which is punctuation read
  // aloud rather than a sentence about entries.
  it('reads the numeral as a sentence', () => {
    expect(enteredSummary({ entered: 6, maxPlayers: 16 })).toBe('6 of 16 entered')
  })
})

describe('capacityFillPercent', () => {
  it('fills the bar in proportion to the entrants', () => {
    expect(capacityFillPercent({ entered: 8, maxPlayers: 16 })).toBe(50)
  })

  it('fills it completely when the event is exactly full', () => {
    expect(capacityFillPercent({ entered: 16, maxPlayers: 16 })).toBe(100)
  })

  // A bar cannot be more than full: an over-full event would otherwise be drawn
  // 119% wide, spilling out of its rail.
  it('clamps an over-full event at 100%', () => {
    expect(capacityFillPercent({ entered: 19, maxPlayers: 16 })).toBe(100)
  })

  // Not a division by zero, and not `NaN` in a `style="width: NaN%"`.
  it('treats a capacity of zero as full rather than dividing by it', () => {
    expect(capacityFillPercent({ entered: 0, maxPlayers: 0 })).toBe(100)
  })
})
