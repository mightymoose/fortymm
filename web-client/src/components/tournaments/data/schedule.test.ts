import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildFixtureTime,
  buildPool,
  buildTables,
  buildTournament,
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
              poolId: 'p-a',
              tableId: 't1',
              scheduledStart: at('11:00'),
            }),
            buildFixture({
              id: 'early',
              poolId: 'p-a',
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
              poolId: 'p-a',
              tableId: 't1',
              scheduledStart: at('09:00'),
            }),
            buildFixture({
              id: 'fx-called',
              poolId: 'p-a',
              round: 2,
              tableId: 't1',
              scheduledStart: at('10:00'),
              pinnedAt: at('09:50'),
              callNotifiedCount: 2,
            }),
            buildFixture({
              id: 'fx-live',
              poolId: 'p-a',
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
            buildFixture({ id: 'known', poolId: 'p-a', tableId: 't1' }),
            buildFixture({ id: 'gone', poolId: 'p-a', tableId: 't-removed' }),
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
      pools: [buildPool({ id: 'pa', tableIds: ['t1'] })],
      fixtures: [buildFixture({ id: 'a1', poolId: 'pa', tableId: 't1', scheduledStart: at('09:00') })],
    })
    const b = buildEvent({
      id: 'ev-b',
      name: 'Event B',
      entrants: buildEntrants(2),
      pools: [buildPool({ id: 'pb', tableIds: ['t1'] })],
      fixtures: [buildFixture({ id: 'b1', poolId: 'pb', tableId: 't1', scheduledStart: at('10:00') })],
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
            buildFixture({ id: 'planned', poolId: 'p-a' }),
            buildFixture({ id: 'live', poolId: 'p-a', matchId: 'm1', matchStatus: 'in_progress' }),
            buildFixture({ id: 'done', poolId: 'p-a', matchId: 'm2', matchStatus: 'completed' }),
            buildFixture({ id: 'void', poolId: 'p-a', matchId: 'm3', matchStatus: 'voided' }),
          ],
        }),
      ],
    })
    const placeable = Object.fromEntries(
      buildSchedule(tournament, buildTables()).awaiting.map((m) => [m.fixtureId, m.placeable]),
    )
    expect(placeable).toEqual({ planned: true, live: true, done: false, void: false })
  })

  it('inherits the placement window from the fixture’s pool slot', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          pools: [buildPool({ id: 'p-a', slot: { date: '2026-07-01', start: '13:00', end: '17:00' } })],
          fixtures: [buildFixture({ id: 'x', poolId: 'p-a' })],
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.window).toEqual({ date: '2026-07-01', start: '13:00', end: '17:00' })
  })

  // ----- an UN-POOLED fixture (ADR 20260807, "a pool restricts scheduling, it does
  // not enable it"): a bracket, a swiss round and a knockout stage carry no pool, so
  // their reservation is the EVENT's own window over the WHOLE tournament's tables.
  // A pool must keep restricting — the two claims are pinned as a pair. -----------

  it('inherits an un-pooled fixture’s placement window from its EVENT slot', () => {
    const tournament = buildTournament({
      events: [
        // A single-elim bracket: `pools: []`, every fixture `poolId: null`. Its event
        // window is the SECOND day of the tournament, deliberately — `buildPool` and
        // `buildEvent` both default to 2026-06-13, so a fixture left on the default
        // date could not tell "read the event slot" from "read a pool slot".
        buildBracketDrawnEvent({
          slot: { date: '2026-06-14', start: '10:00', end: '16:00' },
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.window).toEqual({ date: '2026-06-14', start: '10:00', end: '16:00' })
    expect(match.reservation).toBe('event')
  })

  it('suggests the WHOLE tournament’s tables for an un-pooled fixture', () => {
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

  it('keeps a POOLED fixture on its own pool’s tables — a pool still restricts', () => {
    const tournament = buildTournament({
      events: [
        buildDrawnEvent({
          pools: [buildPool({ id: 'p-a', tableIds: ['t2', 't3'] })],
          fixtures: [buildFixture({ id: 'x', poolId: 'p-a' })],
        }),
      ],
    })
    const [match] = buildSchedule(tournament, buildTables()).awaiting
    expect(match.suggestedTableIds).toEqual(['t2', 't3'])
    expect(match.reservation).toBe('pool')
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
            fixtures: [buildFixture({ id: 'x', poolId: 'p-a', entryAId: 'entry-1', entryBId: 'entry-4' })],
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
