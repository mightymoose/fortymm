import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildFixtureTime,
  buildReservation,
  buildTables,
  buildTournament,
  groupIdFor,
} from './seed.factory'
import {
  buildSchedule,
  composeScheduledStart,
  matchLabel,
  placementConsequence,
  scheduleStatusLabel,
  sideLabel,
} from './schedule'

const at = (time: string) => `2026-06-13T${time}:00`

describe('buildSchedule', () => {
  it('groups placed matches under their table, in predicted-time order', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          fixtures: [
            buildFixture({
              id: 'late',
              groupId: groupIdFor('res-a'),
              tableId: 't1',
              scheduledStart: at('11:00'),
            }),
            buildFixture({
              id: 'early',
              groupId: groupIdFor('res-a'),
              tableId: 't1',
              scheduledStart: at('09:00'),
            }),
          ],
        }),
      ],
    })

    const { tables } = buildSchedule(tournament, buildTables())
    expect(tables).toHaveLength(1)
    expect(tables[0].tableId).toBe('t1')
    // Sorted by predicted start, not by the order they arrived — a schedule that only
    // happened to come out right is one paginated payload away from wrong.
    expect(tables[0].matches.map((m) => m.fixtureId)).toEqual(['early', 'late'])
  })

  it('puts fixtures with no table in the awaiting group', () => {
    const tournament = buildTournament({
      events: [buildDrawnEvent()], // every fixture unplaced by default
    })
    const { tables, awaiting, isEmpty } = buildSchedule(tournament, buildTables())
    expect(isEmpty).toBe(false)
    expect(tables).toHaveLength(0)
    expect(awaiting).toHaveLength(4)
  })

  it('is empty when no draw has been cut anywhere', () => {
    const tournament = buildTournament({ events: [buildEvent({ fixtures: [] })] })
    expect(buildSchedule(tournament, buildTables()).isEmpty).toBe(true)
  })

  it('speaks the boards’ tier vocabulary on every match — with the call’s own timestamp and cost', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          fixtures: [
            buildFixture({
              id: 'fx-est',
              groupId: groupIdFor('res-a'),
              tableId: 't1',
              scheduledStart: at('09:00'),
            }),
            buildFixture({
              id: 'fx-called',
              groupId: groupIdFor('res-a'),
              round: 2,
              tableId: 't1',
              scheduledStart: at('10:00'),
              pinnedAt: at('09:50'),
              callNotifiedCount: 2,
            }),
            buildFixture({
              id: 'fx-live',
              groupId: groupIdFor('res-a'),
              round: 3,
              matchId: 'm-live',
              matchStatus: 'in_progress',
              tableId: 't1',
              scheduledStart: at('11:00'),
              pinnedAt: at('10:50'),
            }),
          ],
        }),
      ],
    })
    const { tables } = buildSchedule(tournament, buildTables())
    const byId = new Map(tables[0].matches.map((m) => [m.fixtureId, m]))
    // The same started > called > estimate precedence the bars draw with.
    expect(byId.get('fx-est')!.tier).toBe('estimate')
    expect(byId.get('fx-called')!.tier).toBe('called')
    expect(byId.get('fx-live')!.tier).toBe('started')
    // The call's facts ride along verbatim, for the list row's badge.
    expect(byId.get('fx-called')!.pinnedAt).toEqual(buildFixtureTime(at('09:50')))
    expect(byId.get('fx-called')!.callNotifiedCount).toBe(2)
    expect(byId.get('fx-est')!.pinnedAt).toBeNull()
    expect(byId.get('fx-est')!.callNotifiedCount).toBe(0)
  })

  it('resolves a table from the catalogue, and shows a dangling ref rather than dropping it', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          fixtures: [
            buildFixture({ id: 'known', groupId: groupIdFor('res-a'), tableId: 't1' }),
            buildFixture({ id: 'gone', groupId: groupIdFor('res-a'), tableId: 't-removed' }),
          ],
        }),
      ],
    })
    const { tables } = buildSchedule(tournament, buildTables())
    const known = tables.find((t) => t.tableId === 't1')
    const gone = tables.find((t) => t.tableId === 't-removed')
    expect(known?.table?.label).toBe('T1')
    // A placement can name a table the catalogue no longer lists (ADR-0790): it is SHOWN
    // under its raw id, never silently dropped.
    expect(gone?.table).toBeNull()
    expect(gone?.matches.map((m) => m.fixtureId)).toEqual(['gone'])
  })

  it('gathers matches across events onto a shared table — the schedule is tournament-scoped', () => {
    const a = buildEvent({
      id: 'ev-a',
      name: 'Event A',
      entrants: buildEntrants(2),
      reservations: [buildReservation({ id: 'res-pa', tableIds: ['t1'] })],
      fixtures: [
        buildFixture({
          id: 'a1',
          groupId: groupIdFor('res-pa'),
          tableId: 't1',
          scheduledStart: at('09:00'),
        }),
      ],
    })
    const b = buildEvent({
      id: 'ev-b',
      name: 'Event B',
      entrants: buildEntrants(2),
      reservations: [buildReservation({ id: 'res-pb', tableIds: ['t1'] })],
      fixtures: [
        buildFixture({
          id: 'b1',
          groupId: groupIdFor('res-pb'),
          tableId: 't1',
          scheduledStart: at('10:00'),
        }),
      ],
    })
    const { tables } = buildSchedule(buildTournament({ events: [a, b] }), buildTables())
    expect(tables).toHaveLength(1)
    expect(tables[0].matches.map((m) => m.fixtureId)).toEqual(['a1', 'b1'])
  })

  it('marks a finished match unplaceable and a live/planned one placeable', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          fixtures: [
            buildFixture({ id: 'planned', groupId: groupIdFor('res-a') }),
            buildFixture({ id: 'live', groupId: groupIdFor('res-a'), matchId: 'm1', matchStatus: 'in_progress' }),
            buildFixture({ id: 'done', groupId: groupIdFor('res-a'), matchId: 'm2', matchStatus: 'completed' }),
            buildFixture({ id: 'void', groupId: groupIdFor('res-a'), matchId: 'm3', matchStatus: 'voided' }),
          ],
        }),
      ],
    })
    const placeable = Object.fromEntries(
      buildSchedule(tournament, buildTables()).awaiting.map((m) => [m.fixtureId, m.placeable]),
    )
    expect(placeable).toEqual({ planned: true, live: true, done: false, void: false })
  })

  it('inherits the placement window from the fixture’s group’s reservation slot', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          reservations: [
            buildReservation({
              id: 'res-a',
              slot: { date: '2026-07-01', start: '13:00', end: '17:00' },
            }),
          ],
          fixtures: [buildFixture({ id: 'x', groupId: groupIdFor('res-a') })],
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.window).toEqual({ date: '2026-07-01', start: '13:00', end: '17:00' })
  })

  // ----- an UNGROUPED fixture (ADR 20260807, "a reservation restricts scheduling, it
  // does not enable it"): a bracket, a swiss round and a knockout stage carry no group,
  // so their reservation is the EVENT's own window over the WHOLE tournament's tables.
  // A reservation must keep restricting — the two claims are pinned as a pair. --------

  it('inherits an ungrouped fixture’s placement window from its EVENT slot', () => {
    const tournament = buildTournament({
      events: [
        // A single-elim bracket: `reservations: []`, every fixture `groupId: null`. Its
        // event window is the SECOND day of the tournament, deliberately —
        // `buildReservation` and `buildEvent` both default to 2026-06-13, so a fixture
        // left on the default date could not tell "read the event slot" from "read a
        // reservation slot".
        buildBracketDrawnEvent({
          slot: { date: '2026-06-14', start: '10:00', end: '16:00' },
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.window).toEqual({ date: '2026-06-14', start: '10:00', end: '16:00' })
    expect(match.reservation).toBe('event')
  })

  it('suggests the WHOLE tournament’s tables for an ungrouped fixture', () => {
    const tournament = buildTournament({ events: [buildBracketDrawnEvent()] })
    // `buildTournament` reserves t1…t8 while the catalogue runs to t12: the
    // suggestion is the TOURNAMENT's reservation, not every table that exists.
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.suggestedTableIds).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
    ])
  })

  it('keeps a GROUPED fixture on its own group’s reservation tables — a reservation still restricts', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          reservations: [buildReservation({ id: 'res-a', tableIds: ['t2', 't3'] })],
          fixtures: [buildFixture({ id: 'x', groupId: groupIdFor('res-a') })],
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.suggestedTableIds).toEqual(['t2', 't3'])
    expect(match.reservation).toBe('booked')
  })

  // ----- a fixture resolves through its GROUP's reservation (ticket #1389): two groups
  // may share one reservation, and a group may have none (#1387, rr-then-ko only). The
  // window and the tables come from the reservation the group maps to, or from the
  // event when it maps to none — never from the group itself. ----------------------

  it('treats a fixture whose group has NO reservation as event-wide: the event’s slot, the whole venue, source `event`', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          drawType: 'rr-then-ko',
          slot: { date: '2026-06-14', start: '10:00', end: '16:00' },
          reservations: [],
          groups: [{ id: 'grp-none', position: 0, reservationId: null }],
          fixtures: [buildFixture({ id: 'x', groupId: 'grp-none' })],
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.window).toEqual({ date: '2026-06-14', start: '10:00', end: '16:00' })
    expect(match.reservation).toBe('event')
    expect(match.suggestedTableIds).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])
  })

  it('resolves two groups that SHARE a reservation to the same window and the same tables', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          drawType: 'rr-then-ko',
          reservations: [
            buildReservation({
              id: 'res-a',
              tableIds: ['t2', 't3'],
              slot: { date: '2026-07-01', start: '13:00', end: '17:00' },
            }),
          ],
          groups: [
            { id: 'grp-0', position: 0, reservationId: 'res-a' },
            { id: 'grp-1', position: 1, reservationId: 'res-a' },
          ],
          fixtures: [
            buildFixture({ id: 'x', groupId: 'grp-0' }),
            buildFixture({ id: 'y', groupId: 'grp-1' }),
          ],
        }),
      ],
    })
    const [x, y] = buildSchedule(tournament, buildTables()).awaiting
    expect(x.window).toEqual({ date: '2026-07-01', start: '13:00', end: '17:00' })
    expect(y.window).toEqual(x.window)
    expect(x.suggestedTableIds).toEqual(['t2', 't3'])
    expect(y.suggestedTableIds).toEqual(x.suggestedTableIds)
    expect([x.reservation, y.reservation]).toEqual(['booked', 'booked'])
  })
})

describe('placement helpers', () => {
  it('composes a naive timestamp from a fixed date + a chosen time', () => {
    // The WRITE path still composes a naive venue wall-clock for the placement
    // PATCH body; the server anchors it to the event timezone. Only the DISPLAY
    // side stopped slicing datetimes (ADR "clients stay tz-math-free"), so there is
    // no `timeOfDay` string-slicer to read a wall-clock back out any more.
    expect(composeScheduledStart('2026-06-13', '09:30')).toBe('2026-06-13T09:30:00')
  })

  it('names a status in a director’s words', () => {
    expect(scheduleStatusLabel(null)).toBe('Not started')
    expect(scheduleStatusLabel({ id: 'm', status: 'in_progress' })).toBe('Unplayed')
    expect(scheduleStatusLabel({ id: 'm', status: 'completed' })).toBe('Completed')
  })

  it('labels a side and a pairing by name, never a raw id', () => {
    expect(sideLabel({ kind: 'entrant', name: 'player.1' })).toBe('player.1')
    expect(sideLabel({ kind: 'tbd' })).toBe('TBD')
    expect(sideLabel({ kind: 'withdrawn' })).toBe('Withdrawn')
    const [match] = buildSchedule(
      buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [buildFixture({ id: 'x', groupId: 'p-a', entryAId: 'entry-1', entryBId: 'entry-4' })],
          }),
        ],
      }),
      buildTables(),
    ).awaiting
    expect(matchLabel(match)).toBe('player.1 vs player.4')
  })
})

// ADR "the schedule is solved; the call is pinned": while LIVE a placement notifies,
// so the submit path prices it; pre-live it is free rearranging. A branch-for-branch
// mirror of the server's `apply_manual_placement` — told-ness is pin AND count, any
// half-placement is a clear, and a TBD side never notifies.
describe('placementConsequence', () => {
  /** A told fixture between two known entrants, and the full placement a director
   * would move it to — each test overrides the one fact its branch turns on. */
  const judge = (over: {
    tournamentStatus?: 'draft' | 'published' | 'live' | 'archived'
    match?: Partial<Parameters<typeof placementConsequence>[0]['match']>
    write?: Partial<Parameters<typeof placementConsequence>[0]['write']>
  }) =>
    placementConsequence({
      tournamentStatus: over.tournamentStatus ?? 'live',
      match: {
        a: { kind: 'entrant', name: 'player.1' },
        b: { kind: 'entrant', name: 'player.4' },
        pinnedAt: buildFixtureTime('2026-06-13T09:50:00'),
        callNotifiedCount: 1,
        ...over.match,
      },
      write: { tableId: 't1', scheduledStart: at('10:30'), ...over.write },
    })

  it('is silent whenever the tournament is not live — planning is free, told or not', () => {
    for (const tournamentStatus of ['draft', 'published', 'archived'] as const) {
      expect(judge({ tournamentStatus })).toBe('silent')
      expect(
        judge({ tournamentStatus, write: { tableId: null, scheduledStart: null } }),
      ).toBe('silent')
    }
  })

  it('reads a live full placement of an UNTOLD fixture as a CALL', () => {
    expect(judge({ match: { pinnedAt: null, callNotifiedCount: 0 } })).toBe('call')
  })

  it('reads a live move of a TOLD fixture as a correction, and a clear as a cancellation', () => {
    expect(judge({ match: { callNotifiedCount: 3 } })).toBe('correction-move')
    expect(
      judge({
        match: { callNotifiedCount: 3 },
        write: { tableId: null, scheduledStart: null },
      }),
    ).toBe('correction-cancel')
  })

  it('treats a HALF-placement as the clear it is — a table with no time cannot stay promised', () => {
    // The server unpins on anything less than a full placement; told, that is the
    // cancelled correction — never a "move" naming a time that was just deleted.
    expect(judge({ write: { scheduledStart: null } })).toBe('correction-cancel')
    expect(
      judge({
        match: { pinnedAt: null, callNotifiedCount: 0 },
        write: { scheduledStart: null },
      }),
    ).toBe('silent')
  })

  it('clears an untold fixture silently even live — nobody was promised anything', () => {
    expect(
      judge({
        match: { pinnedAt: null, callNotifiedCount: 0 },
        write: { tableId: null, scheduledStart: null },
      }),
    ).toBe('silent')
  })

  it('keys told-ness on pin AND count — a cancelled call (count kept, pin gone) is re-placed as a fresh CALL', () => {
    // `call_notified_count` is "how many times the players were told" and a clear
    // does not reset it — but the promise it counted is gone with the pin, so the
    // next live placement CALLS ("moved" would correct a promise nobody holds).
    expect(judge({ match: { pinnedAt: null, callNotifiedCount: 2 } })).toBe('call')
  })

  it('never notifies over a TBD or withdrawn side — a promise to nobody is not a promise', () => {
    expect(
      judge({ match: { b: { kind: 'tbd' }, pinnedAt: null, callNotifiedCount: 0 } }),
    ).toBe('silent')
    expect(
      judge({
        match: { a: { kind: 'withdrawn' }, pinnedAt: null, callNotifiedCount: 0 },
      }),
    ).toBe('silent')
  })
})
