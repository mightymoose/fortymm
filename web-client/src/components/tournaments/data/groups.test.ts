import { describe, expect, it } from 'vitest'

import { parseGroupsAndReservations } from './groups'

const SLOT = { date: '2026-06-13', start: '09:00', end: '12:30' }

const RESERVATION_A = {
  id: 'res-a',
  name: 'Reservation A',
  slot: SLOT,
  table_ids: ['t1', 't2'],
  position: 0,
}

const GROUP_A = { id: 'grp-a', position: 0, reservation_id: 'res-a' }

describe('parseGroupsAndReservations', () => {
  it('parses a group whose reservation_id resolves', () => {
    expect(parseGroupsAndReservations([GROUP_A], [RESERVATION_A])).toEqual({
      groups: [{ id: 'grp-a', position: 0, reservationId: 'res-a' }],
      reservations: [
        {
          id: 'res-a',
          name: 'Reservation A',
          slot: SLOT,
          tableIds: ['t1', 't2'],
          position: 0,
        },
      ],
    })
  })

  /**
   * The rejection this module exists for (ticket #1369): a `groups[].reservation_id`
   * naming no entry of `reservations` is **unreachable from a correct server** — the
   * DB column is `NOT NULL` and a real foreign key — so if it ever arrives, the
   * serializer is broken. Refusing beats rendering a fixture's window from a
   * reservation that silently isn't there.
   */
  it('rejects a group whose reservation_id names no reservation', () => {
    const orphanGroup = { id: 'grp-b', position: 1, reservation_id: 'res-ghost' }
    expect(() => parseGroupsAndReservations([orphanGroup], [RESERVATION_A])).toThrow()
  })

  it('rejects a group whose reservation_id names no reservation, even alongside a valid one', () => {
    const orphanGroup = { id: 'grp-b', position: 1, reservation_id: 'res-ghost' }
    expect(() =>
      parseGroupsAndReservations([GROUP_A, orphanGroup], [RESERVATION_A]),
    ).toThrow()
  })

  it('has nothing to say about an event with no groups or reservations', () => {
    expect(parseGroupsAndReservations([], [])).toEqual({ groups: [], reservations: [] })
  })
})
