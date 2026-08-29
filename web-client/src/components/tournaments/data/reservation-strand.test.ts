import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildFixture,
  buildFixtureTime,
  buildReservation,
  groupIdFor,
} from './seed.factory'
import { newlyStrandedFixtures, placementFlags } from './reservation-strand'
import type { ReservationEntry, Slot } from './types'

/** A `kept` draft entry citing a reservation's own id — the shape `eventToFormValues`
 * seeds the editor with (`keepReservations`, `./reservation-entries`), spelled out
 * directly here so a test can edit one field (its tables, its window) without
 * constructing a whole `Reservation` first. */
function kept(overrides: {
  id: string
  name?: string
  slot: Slot
  tableIds: string[]
}): ReservationEntry {
  return { kind: 'kept', name: 'Reservation A', ...overrides }
}

const WINDOW: Slot = { date: '2026-06-13', start: '09:00', end: '12:30' }

describe('placementFlags', () => {
  const content = { tableIds: ['t1', 't2'], window: WINDOW }

  it('flags a table that is not one of the reservation’s', () => {
    expect(
      placementFlags({ tableId: 't9', scheduledStartNaive: null }, false, content)
        .tableOffReservation,
    ).toBe(true)
  })

  it('does not flag a table the reservation actually holds', () => {
    expect(
      placementFlags({ tableId: 't1', scheduledStartNaive: null }, false, content)
        .tableOffReservation,
    ).toBe(false)
  })

  it('is null on the table axis when no table is placed', () => {
    expect(
      placementFlags({ tableId: null, scheduledStartNaive: '2026-06-13T09:00' }, false, content)
        .tableOffReservation,
    ).toBeNull()
  })

  // The closed-interval rule, at BOTH edges — the exact boundary the server's own
  // doc calls out (`schema.d.ts`'s `start_outside_reservation_window`: "a start
  // landing exactly on either edge counts as inside").
  it('counts a start exactly ON the window’s start as INSIDE it', () => {
    expect(
      placementFlags({ tableId: null, scheduledStartNaive: '2026-06-13T09:00' }, false, content)
        .startOutsideReservationWindow,
    ).toBe(false)
  })

  it('counts a start exactly ON the window’s end as INSIDE it', () => {
    expect(
      placementFlags({ tableId: null, scheduledStartNaive: '2026-06-13T12:30' }, false, content)
        .startOutsideReservationWindow,
    ).toBe(false)
  })

  it('counts a start one minute past the window’s end as OUTSIDE it', () => {
    expect(
      placementFlags({ tableId: null, scheduledStartNaive: '2026-06-13T12:31' }, false, content)
        .startOutsideReservationWindow,
    ).toBe(true)
  })

  it('counts a start one minute before the window’s start as OUTSIDE it', () => {
    expect(
      placementFlags({ tableId: null, scheduledStartNaive: '2026-06-13T08:59' }, false, content)
        .startOutsideReservationWindow,
    ).toBe(true)
  })

  it('is null on the window axis when no start is placed', () => {
    expect(
      placementFlags({ tableId: 't1', scheduledStartNaive: null }, false, content)
        .startOutsideReservationWindow,
    ).toBeNull()
  })

  it('nulls BOTH flags for a decided fixture — its placement is history', () => {
    expect(
      placementFlags(
        { tableId: 't9', scheduledStartNaive: '2026-06-13T20:00' },
        true,
        content,
      ),
    ).toEqual({ tableOffReservation: null, startOutsideReservationWindow: null })
  })

  // The cross-check the ticket asks for: run this SAME function over the SAVED state
  // of a real fixture, and confirm it agrees with the server's own flag for that
  // fixture — not just "this module is internally consistent with itself".
  it('agrees with a server-provided flag for a legitimate (unflagged) placement', () => {
    const fixture = buildFixture({
      tableId: 't2',
      scheduledStart: buildFixtureTime('2026-06-13T10:00:00'),
      // The value the SERVER would have sent for this exact placement + reservation —
      // asserted against below, not assumed.
      tableOffReservation: false,
      startOutsideReservationWindow: false,
    })
    const naive = '2026-06-13T10:00' // `10:00 AM` off `buildFixtureTime`'s own label.
    const result = placementFlags(
      { tableId: fixture.tableId, scheduledStartNaive: naive },
      false,
      content,
    )
    expect(result.tableOffReservation).toBe(fixture.tableOffReservation)
    expect(result.startOutsideReservationWindow).toBe(fixture.startOutsideReservationWindow)
  })
})

describe('newlyStrandedFixtures', () => {
  const TOURNAMENT_TABLE_IDS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']

  it('flags nothing when the draft leaves the reservation unchanged (a no-op diff)', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
        }),
      ],
    })
    const draftSameAsSaved = {
      slot: event.slot,
      reservations: event.reservations.map((r) => kept(r)),
    }
    expect(newlyStrandedFixtures(event, draftSameAsSaved, TOURNAMENT_TABLE_IDS)).toEqual([])
  })

  it('strands a placed match when its table is dropped from the reservation', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1', 't2'] })],
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      reservations: [
        kept({ id: 'res-a', slot: WINDOW, tableIds: ['t2'] }), // t1 dropped
      ],
    }
    const stranded = newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)
    expect(stranded).toEqual([{ fixtureId: 'fx-1', called: false }])
  })

  // The zero-tables edge case: every placed match under the reservation's group is
  // flagged, not just the ones that happen to name a specific dropped table.
  it('strands EVERY placed match of a reservation whose draft leaves it with zero tables', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1', 't2', 't3'] })],
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
        }),
        buildFixture({
          id: 'fx-2',
          round: 2,
          groupId: groupIdFor('res-a'),
          tableId: 't2',
          scheduledStart: '2026-06-13T10:30:00',
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      reservations: [kept({ id: 'res-a', slot: event.reservations[0].slot, tableIds: [] })],
    }
    const stranded = newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)
    expect(stranded.map((s) => s.fixtureId).sort()).toEqual(['fx-1', 'fx-2'])
  })

  // Strand one, un-strand another, in the SAME save: only the newly-stranded one
  // counts. `fx-off` starts placed on a table the reservation does NOT hold (already
  // stranded, server-flagged); the draft adds that table to the reservation, curing it.
  // `fx-on` starts fine and the draft drops ITS table.
  it('counts only the newly-stranded match when one edit strands one and un-strands another', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1', 't2'] })],
      fixtures: [
        buildFixture({
          id: 'fx-off',
          groupId: groupIdFor('res-a'),
          tableId: 't9',
          scheduledStart: '2026-06-13T09:30:00',
          tableOffReservation: true, // the server already flags this one
        }),
        buildFixture({
          id: 'fx-on',
          round: 2,
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      // t9 added (cures fx-off), t1 dropped (strands fx-on).
      reservations: [
        kept({ id: 'res-a', slot: event.reservations[0].slot, tableIds: ['t2', 't9'] }),
      ],
    }
    const stranded = newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)
    expect(stranded).toEqual([{ fixtureId: 'fx-on', called: false }])
  })

  it('does not reopen on a repeat save of an already-stranded match', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t2'] })],
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1', // never was one of the reservation's tables
          scheduledStart: '2026-06-13T09:30:00',
          tableOffReservation: true, // the server's own flag says so already
        }),
      ],
    })
    // The director re-saves with the SAME reservation content — nothing changed.
    const draft = {
      slot: event.slot,
      reservations: event.reservations.map((r) => kept(r)),
    }
    expect(newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)).toEqual([])
  })

  it('names a match CALLED in the summary when its pin is set', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1'] })],
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
          pinnedAt: '2026-06-13T09:00:00',
          callNotifiedCount: 1,
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      reservations: [kept({ id: 'res-a', slot: event.reservations[0].slot, tableIds: [] })],
    }
    expect(newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)).toEqual([
      { fixtureId: 'fx-1', called: true },
    ])
  })

  // A window edit that shifts the reservation's DATE strands every placed time in it
  // at once — the whole point of #1537's date-shift edge case.
  it('strands every placed time in a reservation whose date the draft shifts', () => {
    const event = buildDrawnEvent({
      reservations: [
        buildReservation({
          id: 'res-a',
          tableIds: ['t1', 't2'],
          slot: { date: '2026-06-13', start: '09:00', end: '17:00' },
        }),
      ],
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
        }),
        buildFixture({
          id: 'fx-2',
          round: 2,
          groupId: groupIdFor('res-a'),
          tableId: 't2',
          scheduledStart: '2026-06-13T10:30:00',
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      reservations: [
        kept({
          id: 'res-a',
          // Same tables, same times of day — only the DATE moves.
          slot: { date: '2026-06-14', start: '09:00', end: '17:00' },
          tableIds: ['t1', 't2'],
        }),
      ],
    }
    const stranded = newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)
    expect(stranded.map((s) => s.fixtureId).sort()).toEqual(['fx-1', 'fx-2'])
  })

  // A half-placement (table only, or time only): only the placed half's axis can ever
  // fire — the other stays inapplicable (`null`), so it can never contribute a
  // stranding of its own.
  it('only judges the placed half of a half-placement', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1'] })],
      fixtures: [
        // Table only — no predicted start at all.
        buildFixture({
          id: 'fx-table-only',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      // Drops the table (strands the table half) AND shifts the window's date — but
      // there is no scheduled start on this fixture for the window axis to judge.
      reservations: [
        kept({
          id: 'res-a',
          slot: { date: '2026-06-20', start: '09:00', end: '17:00' },
          tableIds: [],
        }),
      ],
    }
    const stranded = newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)
    expect(stranded).toEqual([{ fixtureId: 'fx-table-only', called: false }])
  })

  it('skips a decided (completed/voided) fixture — its placement is history', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1'] })],
      fixtures: [
        buildFixture({
          id: 'fx-1',
          groupId: groupIdFor('res-a'),
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
          matchId: 'm-1',
          matchStatus: 'completed',
        }),
      ],
    })
    const draft = {
      slot: event.slot,
      reservations: [kept({ id: 'res-a', slot: event.reservations[0].slot, tableIds: [] })],
    }
    expect(newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)).toEqual([])
  })

  it('skips a fixture with no placement at all — nothing to strand', () => {
    const event = buildDrawnEvent({
      reservations: [buildReservation({ id: 'res-a', tableIds: ['t1'] })],
      fixtures: [buildFixture({ id: 'fx-1', groupId: groupIdFor('res-a') })],
    })
    const draft = {
      slot: event.slot,
      reservations: [kept({ id: 'res-a', slot: event.reservations[0].slot, tableIds: [] })],
    }
    expect(newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)).toEqual([])
  })

  // An event-wide (un-grouped) fixture is scheduled against the EVENT's own slot and
  // the tournament's whole table catalogue (ADR 20260807) — an edit to the event's
  // own Basics slot can strand it on the window axis, even though this editor never
  // touches the tournament's table catalogue at all.
  it('strands an EVENT-WIDE fixture when the draft edits the event’s own slot', () => {
    const event = buildBracketDrawnEvent({
      slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
      fixtures: [
        buildFixture({
          id: 'fx-bracket',
          groupId: null,
          tableId: 't1',
          scheduledStart: '2026-06-13T09:30:00',
        }),
      ],
    })
    const draft = {
      // Narrows the event's own window past the placed start.
      slot: { date: '2026-06-13', start: '10:00', end: '18:00' },
      reservations: event.reservations.map((r) => kept(r)),
    }
    const stranded = newlyStrandedFixtures(event, draft, TOURNAMENT_TABLE_IDS)
    expect(stranded).toEqual([{ fixtureId: 'fx-bracket', called: false }])
  })
})
