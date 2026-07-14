import {
  buildDrawnEvent,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildPool,
  buildTables,
  buildTournament,
} from './seed.factory'
import {
  buildSchedule,
  composeScheduledStart,
  matchLabel,
  scheduleStatusLabel,
  sideLabel,
  timeOfDay,
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
})

describe('placement helpers', () => {
  it('composes a naive timestamp from a fixed date + a chosen time', () => {
    expect(composeScheduledStart('2026-06-13', '09:30')).toBe('2026-06-13T09:30:00')
  })

  it('reads the time-of-day back out, tolerating an unscheduled fixture', () => {
    expect(timeOfDay('2026-06-13T09:30:00')).toBe('09:30')
    expect(timeOfDay(null)).toBe('')
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
