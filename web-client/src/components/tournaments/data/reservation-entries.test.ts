import { describe, expect, it } from 'vitest'

import {
  addedReservation,
  keepReservation,
  keepReservations,
  reservationEntryKey,
} from './reservation-entries'
import { buildReservation, buildTenReservations } from './seed.factory'
import type { Slot } from './types'

/** Any window at all — none of these claims turn on when a reservation's tables are
 * held. */
const SLOT: Slot = { date: '2026-06-13', start: '09:00', end: '12:30' }

describe('keepReservation', () => {
  // The point of taking a whole `Reservation` rather than an id: the only ids that can
  // reach the wire are ids a read handed back (ADR 20260801). One this event does not
  // hold is a 422 on that entry, so an id the client made up is not a mistake it may
  // make.
  it('cites the reservation the server sent, with the words it holds today', () => {
    expect(
      keepReservation(
        buildReservation({ id: 'res-7', name: 'Reservation G', tableIds: ['t3'] }),
      ),
    ).toEqual({
      kind: 'kept',
      id: 'res-7',
      name: 'Reservation G',
      slot: SLOT,
      tableIds: ['t3'],
    })
  })

  /** ⚠️ **The `position` does NOT come along.** It is the server's, assigned from the
   * index of the entry in the list it is sent, and both write shapes are
   * `extra="forbid"` — so a position that rode along on an entry would be a 422 naming
   * the field, and the director's whole save refused for a key they never typed. */
  it('drops the server-assigned position', () => {
    const entry = keepReservation(buildReservation({ position: 4 }))
    expect('position' in entry).toBe(false)
  })
})

describe('keepReservations', () => {
  /** The no-op diff, and the reason it has to exist: under an id-keyed diff a stored
   * reservation **no entry cites** is removed. So "I am editing something else about
   * this event" is spelled by citing every reservation, not by sending none. */
  it('cites every stored reservation, in the order it was given them', () => {
    const reservations = buildTenReservations()
    const entries = keepReservations(reservations)

    expect(entries).toHaveLength(10)
    expect(entries.map(reservationEntryKey)).toEqual(reservations.map((r) => r.id))
    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(['kept']))
  })

  it('has nothing to say about an event with no reservations', () => {
    expect(keepReservations([])).toEqual([])
  })
})

describe('addedReservation', () => {
  /** The whole chore in one assertion: a reservation the server has never seen carries
   * **no id key at all**. `ReservationWrite` has no such field and is `extra="forbid"`,
   * so a supplied one is a 422 on `body.reservations[i].id` — and the union arm is what
   * makes that unsayable rather than merely untrue today. */
  it('carries no id, because the client has none to give', () => {
    const entry = addedReservation({ name: 'Reservation B', slot: SLOT, tableIds: ['t1'] })

    expect(entry.kind).toBe('added')
    expect('id' in entry).toBe(false)
    expect(entry).toMatchObject({ name: 'Reservation B', slot: SLOT, tableIds: ['t1'] })
  })

  /** Two reservations added in the same session must be two cards, not one rendered
   * twice: the key is what React and `reservationNameIssues` address a card by, and
   * every event has a “Reservation A”, so it cannot be derived from anything the
   * director typed. */
  it('mints a distinct card key per reservation', () => {
    const draft = { name: 'Reservation A', slot: SLOT, tableIds: [] }
    expect(reservationEntryKey(addedReservation(draft))).not.toBe(
      reservationEntryKey(addedReservation(draft)),
    )
  })
})

describe('reservationEntryKey', () => {
  it('is the server’s id for a stored reservation and the card key for a new one', () => {
    expect(reservationEntryKey(keepReservation(buildReservation({ id: 'res-1' })))).toBe(
      'res-1',
    )

    const added = addedReservation({ name: 'Reservation B', slot: SLOT, tableIds: [] })
    expect(reservationEntryKey(added)).toBe(
      added.kind === 'added' ? added.key : undefined,
    )
  })
})
