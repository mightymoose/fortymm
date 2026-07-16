import {
  buildDrawnEvent,
  buildEntrants,
  buildFixture,
  buildPool,
  buildTables,
  buildTournament,
} from './seed.factory'
import {
  axisTicks,
  buildTimelineBoard,
  calledAtLabel,
  estimatedMatchMinutes,
  fixtureTier,
  fmtBoardClock,
  notifiedLabel,
  tierSentence,
} from './timeline'
import type { Fixture, Tournament, TournamentEvent } from './types'

/** The drawn U1200 event with every Pool A fixture placed — one per tier — and
 * Pool B's single fixture left unplaced. The placements sit inside Pool A's
 * `09:00–12:30` window on `t1`/`t2`. */
const placedEvent = (): TournamentEvent =>
  buildDrawnEvent({
    fixtures: [
      // An ESTIMATE: placed, unpinned, no match yet.
      buildFixture({
        id: 'fx-est',
        poolId: 'p-a',
        entryAId: 'entry-1',
        entryBId: 'entry-4',
        tableId: 't1',
        scheduledStart: '2026-06-13T09:00:00',
      }),
      // A CALL: pinned — the players were notified. Twice: a correction has
      // already gone out, so the bar owes a `notified 2×` marker.
      buildFixture({
        id: 'fx-called',
        poolId: 'p-a',
        round: 2,
        entryAId: 'entry-1',
        entryBId: 'entry-5',
        tableId: 't2',
        scheduledStart: '2026-06-13T10:00:00',
        pinnedAt: '2026-06-13T09:50:00',
        callNotifiedCount: 2,
      }),
      // STARTED: in progress — and pinned, which the started tier outranks.
      buildFixture({
        id: 'fx-live',
        poolId: 'p-a',
        round: 3,
        entryAId: 'entry-4',
        entryBId: 'entry-5',
        matchId: 'm-live',
        matchStatus: 'in_progress',
        tableId: 't1',
        scheduledStart: '2026-06-13T11:00:00',
        pinnedAt: '2026-06-13T10:50:00',
      }),
      // Unplaced — Pool B's fixture stays off the axis, in the rail.
      buildFixture({
        id: 'fx-await',
        poolId: 'p-b',
        entryAId: 'entry-2',
        entryBId: 'entry-3',
      }),
    ],
  })

const boardOf = (tournament: Tournament) =>
  buildTimelineBoard(tournament, buildTables())

describe('estimatedMatchMinutes', () => {
  // The client mirror of the server's `match_minutes` (api/app/scheduling.py):
  // the solver plans with exactly these figures, so the bars must too.
  it.each([
    [1, 15],
    [3, 25],
    [5, 35],
    [7, 45],
  ] as const)('estimates a best-of-%i match at %i minutes', (length, minutes) => {
    expect(estimatedMatchMinutes(length)).toBe(minutes)
  })
})

describe('fixtureTier', () => {
  const placed: Partial<Fixture> = {
    tableId: 't1',
    scheduledStart: '2026-06-13T09:00:00',
  }

  it('reads an unpinned placement as an estimate', () => {
    expect(fixtureTier(buildFixture(placed))).toBe('estimate')
  })

  it('reads a pinned placement as called', () => {
    expect(
      fixtureTier(buildFixture({ ...placed, pinnedAt: '2026-06-13T08:50:00' })),
    ).toBe('called')
  })

  it('reads an in-progress match as started — even when pinned (started outranks the pin)', () => {
    expect(
      fixtureTier(
        buildFixture({
          ...placed,
          matchId: 'm-1',
          matchStatus: 'in_progress',
          pinnedAt: '2026-06-13T08:50:00',
        }),
      ),
    ).toBe('started')
  })

  it('reads completed and voided matches as started too', () => {
    for (const status of ['completed', 'voided'] as const) {
      expect(
        fixtureTier(buildFixture({ ...placed, matchId: 'm-1', matchStatus: status })),
      ).toBe('started')
    }
  })

  it('keeps a match reset to pending an estimate — it is a plan again', () => {
    expect(
      fixtureTier(buildFixture({ ...placed, matchId: 'm-1', matchStatus: 'pending' })),
    ).toBe('estimate')
  })
})

describe('tierSentence', () => {
  it('labels an estimate as movable and a TOLD call as notified', () => {
    expect(tierSentence('estimate', null, 0)).toBe(
      'Estimate — the scheduler may still move it',
    )
    expect(tierSentence('called', null, 1)).toBe(
      'Called — the players were notified',
    )
  })

  it('labels a SILENT pin as pinned — it must not claim a notification nobody received', () => {
    // Pinned is not told: every manual placement pins (pre-live included), but
    // only a live one notifies — a count of 0 means the players heard nothing.
    expect(tierSentence('called', null, 0)).toBe('Pinned — placed by the director')
  })

  it("says a started bar's actual state", () => {
    expect(tierSentence('started', 'in_progress', 1)).toBe('In progress')
    expect(tierSentence('started', 'completed', 0)).toBe('Completed')
  })
})

describe('calledAtLabel', () => {
  it('reads the call’s wall-clock minute straight off the naive stamp', () => {
    expect(calledAtLabel('2026-06-13T08:50:00')).toBe('Called 08:50')
    expect(calledAtLabel('2026-06-13T14:32')).toBe('Called 14:32')
  })

  it('tolerates a bare date the way the board’s own stamp split does', () => {
    expect(calledAtLabel('2026-06-13')).toBe('Called 00:00')
  })
})

describe('notifiedLabel', () => {
  it('counts only past the first call — one notification is the ordinary case', () => {
    expect(notifiedLabel(0)).toBeNull()
    expect(notifiedLabel(1)).toBeNull()
    expect(notifiedLabel(2)).toBe('notified 2×')
    expect(notifiedLabel(3)).toBe('notified 3×')
  })
})

describe('fmtBoardClock', () => {
  it('renders wall-clock HH:MM, zero-padded', () => {
    expect(fmtBoardClock(540)).toBe('09:00')
    expect(fmtBoardClock(605)).toBe('10:05')
  })

  it('wraps past midnight into the next day’s wall-clock', () => {
    expect(fmtBoardClock(1440 + 570)).toBe('09:30')
  })
})

describe('axisTicks', () => {
  it('ticks every 30 minutes over a short window', () => {
    expect(axisTicks(540, 630)).toEqual([
      { min: 540, label: '09:00' },
      { min: 570, label: '09:30' },
      { min: 600, label: '10:00' },
      { min: 630, label: '10:30' },
    ])
  })

  it('opens to hourly ticks past six hours', () => {
    const ticks = axisTicks(540, 540 + 420)
    expect(ticks[0]).toEqual({ min: 540, label: '09:00' })
    expect(ticks[1]).toEqual({ min: 600, label: '10:00' })
  })
})

describe('buildTimelineBoard', () => {
  it('derives the window from the earliest pool start to the latest end, padded to the half-hour', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    // Pool A opens 09:00 (earliest window start) on the origin date.
    expect(board.originDate).toBe('2026-06-13')
    expect(board.startMin).toBe(9 * 60)
    // Pool B's window runs to 17:00 — later than every placement end.
    expect(board.endMin).toBe(17 * 60)
  })

  it('stretches the window when a placement ends past its pool window', () => {
    const event = buildDrawnEvent({
      pools: [buildPool({ id: 'p-a', name: 'Pool A' })], // 09:00–12:30
      fixtures: [
        buildFixture({
          id: 'fx-late',
          poolId: 'p-a',
          tableId: 't1',
          // Bo5 → 35 estimated minutes: ends 12:50, past the 12:30 window end.
          scheduledStart: '2026-06-13T12:15:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    expect(board.endMin).toBe(13 * 60) // 12:50 padded up to 13:00
  })

  it('falls back to the pools’ windows when nothing is placed yet', () => {
    const board = boardOf(buildTournament({ events: [buildDrawnEvent()] }))
    expect(board.hasBars).toBe(false)
    expect(board.startMin).toBe(9 * 60)
    expect(board.endMin).toBe(17 * 60)
    // …and every fixture is in the rail, awaiting the solver.
    expect(board.unscheduled.map((u) => u.fixtureId)).toEqual([
      'fx-a-1',
      'fx-a-2',
      'fx-a-3',
      'fx-b-1',
    ])
  })

  it('positions bars on the estimated duration, in venue wall-clock', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    const t1 = board.tables.find((r) => r.tableId === 't1')!
    const bar = t1.bars.find((b) => b.fixtureId === 'fx-est')!
    expect(bar.startMin).toBe(9 * 60)
    expect(bar.durationMin).toBe(35) // the event is Bo5
    expect(bar.endMin).toBe(9 * 60 + 35)
    expect(bar.startClock).toBe('09:00')
    expect(bar.endClock).toBe('09:35')
    expect(bar.label).toBe('player.1 vs player.4')
    expect(bar.tableLabel).toBe('T1')
    expect(bar.poolName).toBe('Pool A')
  })

  it('counts minutes across days from the earliest date (a two-day board)', () => {
    const event = buildDrawnEvent({
      pools: [
        buildPool({ id: 'p-a', name: 'Pool A' }), // 2026-06-13
        buildPool({
          id: 'p-b',
          name: 'Pool B',
          slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
        }),
      ],
      fixtures: [
        buildFixture({
          id: 'fx-day2',
          poolId: 'p-b',
          entryAId: 'entry-2',
          entryBId: 'entry-3',
          tableId: 't3',
          scheduledStart: '2026-06-14T09:30:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    expect(board.originDate).toBe('2026-06-13')
    const bar = board.tables.find((r) => r.tableId === 't3')!.bars[0]
    expect(bar.startMin).toBe(1440 + 9 * 60 + 30)
    expect(bar.startClock).toBe('09:30') // wall-clock, day 2
  })

  it('assigns the three tiers by started > called > estimate', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    const bars = new Map(
      board.tables.flatMap((r) => r.bars).map((b) => [b.fixtureId, b]),
    )
    expect(bars.get('fx-est')!.tier).toBe('estimate')
    expect(bars.get('fx-called')!.tier).toBe('called')
    expect(bars.get('fx-live')!.tier).toBe('started')
  })

  it('carries the call’s cost onto the bar verbatim — pinnedAt and the notified count', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    const bars = new Map(
      board.tables.flatMap((r) => r.bars).map((b) => [b.fixtureId, b]),
    )
    expect(bars.get('fx-called')!.pinnedAt).toBe('2026-06-13T09:50:00')
    expect(bars.get('fx-called')!.callNotifiedCount).toBe(2)
    // A never-called estimate has promised nothing and cost nothing.
    expect(bars.get('fx-est')!.pinnedAt).toBeNull()
    expect(bars.get('fx-est')!.callNotifiedCount).toBe(0)
  })

  it('gives every tournament table a row — bars or none — in the tournament’s order', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    expect(board.tables.map((r) => r.tableId)).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
    ])
    expect(board.tables.find((r) => r.tableId === 't3')!.bars).toEqual([])
  })

  it('rows a placement on a table the catalogue no longer lists under its raw id — shown, never dropped', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-ghost',
          poolId: 'p-a',
          tableId: 't-gone',
          scheduledStart: '2026-06-13T09:00:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const row = board.tables.find((r) => r.tableId === 't-gone')!
    expect(row.label).toBe('t-gone')
    expect(row.known).toBe(false)
    expect(row.bars.map((b) => b.fixtureId)).toEqual(['fx-ghost'])
  })

  it('puts a table-only placement (no time) in the rail, with its table named', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({ id: 'fx-half', poolId: 'p-a', tableId: 't2' }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    expect(board.hasBars).toBe(false)
    expect(board.unscheduled).toEqual([
      expect.objectContaining({
        fixtureId: 'fx-half',
        tableLabel: 'T2',
        label: 'player.1 vs player.2',
        statusLabel: 'Not started',
      }),
    ])
  })

  it('rows every entrant with a fixture, sorted by username, with their placed bars facing the right opponent', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    expect(board.players.map((p) => p.username)).toEqual([
      'player.1',
      'player.2',
      'player.3',
      'player.4',
      'player.5',
    ])
    const p1 = board.players.find((p) => p.username === 'player.1')!
    expect(p1.bars.map((b) => [b.fixtureId, b.opponent])).toEqual([
      ['fx-est', 'player.4'],
      ['fx-called', 'player.5'],
    ])
    // Pool B's players have a fixture but no placement: an honest empty track.
    expect(board.players.find((p) => p.username === 'player.2')!.bars).toEqual([])
  })

  it('rows no one for an entrant with no fixture, and no row for a withdrawn side', () => {
    const event = buildDrawnEvent({
      entrants: buildEntrants(5),
      fixtures: [
        // entry-9 is nobody the event lists — a withdrawn side.
        buildFixture({
          id: 'fx-w',
          poolId: 'p-a',
          entryAId: 'entry-1',
          entryBId: 'entry-9',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    expect(board.players.map((p) => p.username)).toEqual(['player.1'])
    // The withdrawn opponent is still named on the bar, in the draw's word.
    expect(board.players[0].bars[0].opponent).toBe('Withdrawn')
  })
})
