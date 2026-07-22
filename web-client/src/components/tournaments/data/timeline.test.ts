import {
  buildDrawnEvent,
  buildEntrants,
  buildFixture,
  buildFixtureTime,
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
  isDecided,
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
    scheduledStart: buildFixtureTime('2026-06-13T09:00:00'),
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
  const told = {
    pinnedAt: buildFixtureTime('2026-06-13T08:50:00'),
    callNotifiedCount: 1,
  }
  const untold = { pinnedAt: null, callNotifiedCount: 0 }

  it('labels an estimate as movable and a TOLD call as notified', () => {
    expect(tierSentence('estimate', null, untold)).toBe(
      'Estimate — the scheduler may still move it',
    )
    expect(tierSentence('called', null, told)).toBe(
      'Called — the players were notified',
    )
  })

  it('labels a SILENT pin as pinned — it must not claim a notification nobody received', () => {
    // Pinned is not told (`isTold`): every manual placement pins (pre-live
    // included), but only a live one notifies — a count of 0 means the players
    // heard nothing.
    expect(
      tierSentence('called', null, {
        pinnedAt: buildFixtureTime('2026-06-13T08:50:00'),
        callNotifiedCount: 0,
      }),
    ).toBe('Pinned — placed by the director')
  })

  it('does NOT claim live play for an in_progress match — materialized means scoreable, not being played', () => {
    // Go-live materializes EVERY round-robin fixture into an `in_progress`
    // match, so "In progress" here would call a match hours out live (the
    // QA-caught lie on the Gantt's aria).
    expect(tierSentence('started', 'in_progress', told)).toBe(
      'Underway or up next — scores can be entered',
    )
  })

  it("says a decided bar's actual state", () => {
    expect(tierSentence('started', 'completed', untold)).toBe('Completed')
    expect(tierSentence('started', 'voided', untold)).toBe('Voided')
  })
})

describe('isDecided', () => {
  it('is true only for completed and voided — the statuses that retire a call marker', () => {
    expect(isDecided(null)).toBe(false)
    expect(isDecided('pending')).toBe(false)
    expect(isDecided('in_progress')).toBe(false)
    expect(isDecided('completed')).toBe(true)
    expect(isDecided('voided')).toBe(true)
  })
})

describe('calledAtLabel', () => {
  it('reads the call’s venue-local label + tz abbrev straight off the server-rendered FixtureTime', () => {
    // The server already rendered the venue wall-clock; the client shows it
    // verbatim with the timezone, never slicing a datetime or picking a zone.
    expect(calledAtLabel(buildFixtureTime('2026-06-13T08:50:00'))).toBe(
      'Called 8:50 AM CDT',
    )
    expect(calledAtLabel(buildFixtureTime('2026-06-13T14:32:00'))).toBe(
      'Called 2:32 PM CDT',
    )
  })

  it('labels the timezone even for a midnight call — a same-column bar must not imply a shared instant', () => {
    expect(calledAtLabel(buildFixtureTime('2026-06-13T00:00:00'))).toBe(
      'Called 12:00 AM CDT',
    )
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
  it('derives the window from the earliest placed bar to the latest bar end, padded to the half-hour', () => {
    const board = boardOf(buildTournament({ events: [placedEvent()] }))
    // Instant-anchored, not pool-window-anchored (ADR "tournament times are
    // timezone-aware instants"): the window spans the placed bars, not the naive
    // pool windows (which can't join the instant axis). Earliest bar 09:00 on the
    // origin date; latest bar ends 11:35, padded up to 12:00.
    expect(board.originDate).toBe('2026-06-13')
    expect(board.startMin).toBe(9 * 60)
    expect(board.endMin).toBe(12 * 60)
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

  it('shows a token hour when nothing is placed yet — the naive pool windows can’t size an instant axis', () => {
    const board = boardOf(buildTournament({ events: [buildDrawnEvent()] }))
    // Before any bar exists there is no instant to anchor to (the pool windows are
    // naive venue wall-clock and never join the instant axis), so the board draws a
    // token 09:00–10:00 hour and the Schedule tab shows the "run the scheduler" prompt.
    expect(board.hasBars).toBe(false)
    expect(board.startMin).toBe(9 * 60)
    expect(board.endMin).toBe(10 * 60)
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
    // The bar shows the server's own venue-local words plus the tz abbrev — never
    // a client-sliced datetime (ADR "a schedule surface always labels the timezone").
    expect(bar.startClock).toBe('9:00 AM')
    expect(bar.endClock).toBe('9:35 AM')
    expect(bar.tz).toBe('CDT')
    expect(bar.label).toBe('player.1 vs player.4')
    expect(bar.tableLabel).toBe('T1')
    expect(bar.poolName).toBe('Pool A')
  })

  it('counts minutes across days by instant differencing, from the earliest placed bar', () => {
    // The board minute axis is anchored to the earliest BAR's venue wall-clock and
    // spaced by real instant differences (ADR "tournament times are timezone-aware
    // instants"): a day-1 09:00 bar is the origin, and a day-2 09:30 bar sits a full
    // day + 30 minutes later — 24h30m of instant difference, tz-agnostic.
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
          id: 'fx-day1',
          poolId: 'p-a',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
        }),
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
    // The origin is the earliest bar's venue date (day 1), not the earliest pool.
    expect(board.originDate).toBe('2026-06-13')
    const bar = board.tables.find((r) => r.tableId === 't3')!.bars[0]
    expect(bar.startMin).toBe(1440 + 9 * 60 + 30)
    expect(bar.startClock).toBe('9:30 AM') // venue wall-clock, day 2
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
    expect(bars.get('fx-called')!.pinnedAt).toEqual(
      buildFixtureTime('2026-06-13T09:50:00'),
    )
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

  // A decided match draws its ACTUAL end (`completedAt`), not a projection of the
  // estimate — `startMin` still anchors to `scheduledStart` (we don't try to detect
  // an actual start, only an actual end).
  it("draws a completed match's bar to its actual completion time, past the estimate", () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-ran-long',
          poolId: 'p-a',
          tableId: 't1',
          // Bo5 → 35 estimated minutes: 09:00 + 35 = 09:35. The match actually
          // ran to 10:20 — 80 minutes, not 35.
          scheduledStart: '2026-06-13T09:00:00',
          matchId: 'm-1',
          matchStatus: 'completed',
          completedAt: '2026-06-13T10:20:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const bar = board.tables.find((r) => r.tableId === 't1')!.bars[0]
    expect(bar.startMin).toBe(9 * 60) // unchanged: still anchored to scheduledStart
    expect(bar.durationMin).toBe(80)
    expect(bar.endMin).toBe(9 * 60 + 80)
    // The decided bar's end reads the server's real completion label, not a projection.
    expect(bar.endClock).toBe('10:20 AM')
  })

  it("draws a completed match's bar SHORTER than the estimate when it finished early", () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-ran-short',
          poolId: 'p-a',
          tableId: 't1',
          // Bo5 → 35 estimated minutes, but the match finished in 12.
          scheduledStart: '2026-06-13T09:00:00',
          matchId: 'm-1',
          matchStatus: 'completed',
          completedAt: '2026-06-13T09:12:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const bar = board.tables.find((r) => r.tableId === 't1')!.bars[0]
    expect(bar.durationMin).toBe(12)
    expect(bar.endMin).toBe(9 * 60 + 12)
  })

  it('also uses the actual completion time for a voided match — completedAt is set on decide, not just on a win', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-voided',
          poolId: 'p-a',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
          matchId: 'm-1',
          matchStatus: 'voided',
          completedAt: '2026-06-13T09:05:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const bar = board.tables.find((r) => r.tableId === 't1')!.bars[0]
    expect(bar.durationMin).toBe(5)
  })

  it('clamps to a minimum 1-minute bar when completedAt is at or before scheduledStart, rather than a backwards/zero-width bar', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-bad-stamp',
          poolId: 'p-a',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
          matchId: 'm-1',
          matchStatus: 'completed',
          // Untrusted network data: completedAt should always be after
          // scheduledStart in practice, but don't trust it blindly.
          completedAt: '2026-06-13T08:55:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const bar = board.tables.find((r) => r.tableId === 't1')!.bars[0]
    expect(bar.durationMin).toBe(1)
    expect(bar.endMin).toBe(bar.startMin + 1)
  })

  it('keeps the estimated duration for a completed match with no completedAt (defensive: should not happen)', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-no-stamp',
          poolId: 'p-a',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
          matchId: 'm-1',
          matchStatus: 'completed',
          completedAt: null,
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const bar = board.tables.find((r) => r.tableId === 't1')!.bars[0]
    expect(bar.durationMin).toBe(35) // the estimate, Bo5
  })

  it('keeps the estimated duration for an in-progress (not yet decided) match even when completedAt is somehow set', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-live',
          poolId: 'p-a',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
          matchId: 'm-1',
          matchStatus: 'in_progress',
          completedAt: '2026-06-13T09:05:00',
        }),
      ],
    })
    const board = boardOf(buildTournament({ events: [event] }))
    const bar = board.tables.find((r) => r.tableId === 't1')!.bars[0]
    expect(bar.durationMin).toBe(35) // the estimate, Bo5 — not decided yet
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
