import { HttpResponse } from 'msw'

import { waitFor, within } from '@/test/utilities'
import {
  mockFixturePlacementEndpoint,
  mockScheduleSolveEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import {
  buildScheduleSolveRead,
  buildTournamentFixtureRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'

import {
  buildDrawnEvent,
  buildFixture,
  buildScheduleSolve,
  buildTables,
  buildTournament,
} from '../data/seed.factory'
import { scheduleTabPage as page } from './schedule-tab.page'

/** A drawn event with one match PLACED on table `t1` (in progress) and one still
 * awaiting a table — the two groups the schedule sorts fixtures into. */
const buildScheduledEvent = () =>
  buildDrawnEvent({
    fixtures: [
      buildFixture({
        id: 'fx-a-1',
        poolId: 'p-a',
        round: 1,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-4',
        matchId: 'm-a-1',
        matchStatus: 'in_progress',
        tableId: 't1',
        scheduledStart: '2026-06-13T09:00:00',
      }),
      buildFixture({
        id: 'fx-a-2',
        poolId: 'p-a',
        round: 2,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-5',
      }),
    ],
  })

describe('ScheduleTab', () => {
  it('groups the tournament’s real matches by table, with an awaiting-placement group', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })

    // The placed match sits in its table's column, named — not a mock pool window.
    const t1 = page.getTableColumn('t1')
    expect(page.matchIdsIn(t1)).toEqual(['fx-a-1'])
    expect(within(t1).getByTestId('schedule-match-fx-a-1')).toHaveTextContent(
      'player.1 vs player.4',
    )
    expect(page.getStatus('fx-a-1')).toHaveTextContent('Unplayed')

    // The unplaced match is in the awaiting group — a live tournament's matches start
    // here, not in an empty grid.
    const awaiting = page.getAwaiting()
    expect(page.matchIdsIn(awaiting)).toEqual(['fx-a-2'])
  })

  it('keeps the reserved pool windows visible as context', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    expect(page.queryWindows()).toBeInTheDocument()
  })

  it('shows the designed empty state when no draw has been cut anywhere', () => {
    page.render({
      tournament: buildTournament({ events: [buildDrawnEvent({ fixtures: [] })] }),
      tables: buildTables(),
    })
    expect(page.getTab()).toHaveTextContent('Nothing to schedule yet')
  })

  it('lets the owner place an awaiting match, and the mutation carries the composed time', async () => {
    let sent: unknown = null
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-a-2',
          table_id: 't2',
          scheduled_start: '2026-06-13T10:30:00',
        }),
      )
    })

    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })

    page.openPlacement('fx-a-2')
    expect(page.queryPlaceEditor('fx-a-2')).toBeInTheDocument()
    page.setPlaceTime('fx-a-2', '10:30')
    page.savePlacement('fx-a-2')

    // The editor closes on success — the placement re-renders from the refetched
    // tournament, not from a local write.
    await waitFor(() => expect(page.queryPlaceEditor('fx-a-2')).not.toBeInTheDocument())
    // The naive timestamp is composed from the pool window's DATE + the chosen time
    // (ADR-0790) — no timezone, no Date coercion.
    expect(sent).toMatchObject({ scheduled_start: '2026-06-13T10:30:00' })
  })

  it('places a match with no predicted time as a table-only placement (scheduled_start: null)', async () => {
    let sent: unknown = null
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-a-2',
          table_id: 't1',
          scheduled_start: null,
        }),
      )
    })

    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })

    page.openPlacement('fx-a-2')
    // Clear the predicted-start time, then Save — this must NOT be a silent no-op.
    page.setPlaceTime('fx-a-2', '')
    page.savePlacement('fx-a-2')

    // The editor closes on success — an empty time is a valid table-only placement,
    // not a malformed timestamp the server rejects and the panel silently swallows.
    await waitFor(() => expect(page.queryPlaceEditor('fx-a-2')).not.toBeInTheDocument())
    // The mutation carries an explicit null time — the fixture is placed on the table
    // (its pool's first suggested table, `t1`) with no prediction, never a composed
    // `YYYY-MM-DDT:00`.
    expect(sent).toMatchObject({ table_id: 't1', scheduled_start: null })
  })

  it('does not offer to move a finished match (its placement is frozen)', () => {
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-done',
                poolId: 'p-a',
                entryAId: 'entry-1',
                entryBId: 'entry-4',
                matchId: 'm-done',
                matchStatus: 'completed',
                tableId: 't1',
                scheduledStart: '2026-06-13T09:00:00',
              }),
            ],
          }),
        ],
      }),
      tables: buildTables(),
    })
    expect(page.getStatus('fx-done')).toHaveTextContent('Completed')
    expect(page.queryPlaceTrigger('fx-done')).not.toBeInTheDocument()
  })

  // ADR-0015: a non-owner sees the schedule as a VIEW — the same matches, and zero
  // EDITING controls (no placement control, not a disabled one; no Run scheduler).
  // The view toggle stays: choosing how to read the schedule is a reading
  // affordance, the Events tab's "View" open-target precedent — so the sweep
  // asserts the toggle's items are the ONLY controls left.
  it('renders no editing controls for a non-owner — the view toggle is all that remains', () => {
    page.render({
      tournament: buildTournament({
        canEdit: false,
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    // The schedule still renders for them.
    expect(page.queryTableColumn('t1')).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-a-2')).not.toBeInTheDocument()
    expect(page.queryRunScheduler()).not.toBeInTheDocument()
    expect(page.getEditingControls()).toHaveLength(0)
    // …and the whole-sweep remainder is the view toggle alone (its three items,
    // plus radix's roving-focus wrapper).
    const controls = page.getControls()
    expect(controls.length).toBeGreaterThan(0)
    expect(
      controls.every(
        (el) => el.closest('[data-testid="schedule-view-toggle"]') !== null,
      ),
    ).toBe(true)
  })

  it('offers a non-owner no editing control on the boards either', () => {
    page.render({
      tournament: buildTournament({
        canEdit: false,
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    page.setView('Gantt')
    expect(page.gantt.queryBoard()).toBeInTheDocument()
    expect(page.getEditingControls()).toHaveLength(0)
  })

  // ----- the tier markers on the LIST rows (ADR "the schedule is solved; the
  // call is pinned"): the list is the default view, so it must distinguish a
  // promise from a plan exactly as the boards do — `est` on an estimate, the
  // called-at badge (and the corrections' cost) on a call. -------------------

  /** One event holding all three tiers, placed on `t1`: an estimate at 09:00, a
   * twice-notified call at 10:00, and an in-progress match at 11:00. */
  const buildTieredEvent = () =>
    buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-est',
          poolId: 'p-a',
          entryAId: 'entry-1',
          entryBId: 'entry-4',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
        }),
        buildFixture({
          id: 'fx-called',
          poolId: 'p-a',
          round: 2,
          entryAId: 'entry-1',
          entryBId: 'entry-5',
          tableId: 't1',
          scheduledStart: '2026-06-13T10:00:00',
          pinnedAt: '2026-06-13T09:50:00',
          callNotifiedCount: 2,
        }),
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
      ],
    })

  it('marks a scheduled estimate `est` on its list row — and only an estimate', () => {
    page.render({
      tournament: buildTournament({ events: [buildTieredEvent()] }),
      tables: buildTables(),
    })
    expect(page.getMatch('fx-est')).toHaveTextContent('09:00 · est')
    // A call is a promise and a started match is fact — neither is an estimate,
    // so neither says `est`.
    expect(page.queryEst('fx-called')).not.toBeInTheDocument()
    expect(page.queryEst('fx-live')).not.toBeInTheDocument()
  })

  it('badges a called match on its list row — the called-at time and the notified count', () => {
    page.render({
      tournament: buildTournament({ events: [buildTieredEvent()] }),
      tables: buildTables(),
    })
    expect(page.getCalledBadge('fx-called')).toHaveTextContent('Called 09:50')
    expect(page.queryNotified('fx-called')).toHaveTextContent('notified 2×')
    // The estimate has promised nothing; the started match reads as its status,
    // not as the promise it once was (started outranks the pin, as on the bars).
    expect(page.queryCalledBadge('fx-est')).not.toBeInTheDocument()
    expect(page.queryCalledBadge('fx-live')).not.toBeInTheDocument()
    expect(page.queryNotified('fx-est')).not.toBeInTheDocument()
  })

  it('keeps the notified counter off a once-called row — one call is the ordinary case', () => {
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-called-once',
                poolId: 'p-a',
                entryAId: 'entry-1',
                entryBId: 'entry-4',
                tableId: 't1',
                scheduledStart: '2026-06-13T10:00:00',
                pinnedAt: '2026-06-13T09:50:00',
                callNotifiedCount: 1,
              }),
            ],
          }),
        ],
      }),
      tables: buildTables(),
    })
    expect(page.getCalledBadge('fx-called-once')).toHaveTextContent('Called 09:50')
    expect(page.queryNotified('fx-called-once')).not.toBeInTheDocument()
  })

  // ----- the view toggle & the boards (ADR "the schedule is solved") ----------

  it('defaults to the list view — the toggle offered, the boards not yet drawn', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    expect(page.queryViewToggle()).toBeInTheDocument()
    expect(page.queryTableColumn('t1')).toBeInTheDocument()
    expect(page.gantt.queryBoard()).not.toBeInTheDocument()
    expect(page.players.queryBoard()).not.toBeInTheDocument()
    expect(page.legend.queryLegend()).not.toBeInTheDocument()
  })

  it('switches to the Gantt board — bars where the list rows were, the legend up', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    page.setView('Gantt')

    expect(page.gantt.queryBoard()).toBeInTheDocument()
    expect(page.queryTableColumn('t1')).not.toBeInTheDocument()
    expect(page.legend.queryLegend()).toBeInTheDocument()
    // Wiring only: the placed fixture's bar lands in its table's row — the
    // board's own rendering is pinned by the gantt-board / timeline tests.
    expect(page.gantt.barIdsIn('t1')).toEqual(['fx-a-1'])
    // The unplaced fixture is in the rail, not lost.
    expect(page.gantt.getItem('fx-a-2')).toBeInTheDocument()
  })

  it('switches to the player timeline', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    page.setView('Player timeline')

    expect(page.players.queryBoard()).toBeInTheDocument()
    expect(page.gantt.queryBoard()).not.toBeInTheDocument()
    expect(page.players.rowNames()).toEqual([
      'player.1',
      'player.4',
      'player.5',
    ])
  })

  it('keeps the current view when the active toggle item is re-clicked (radix empties the value)', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    page.setView('Gantt')
    page.setView('Gantt')
    expect(page.gantt.queryBoard()).toBeInTheDocument()
  })

  it('prompts the owner to run the scheduler when a board view has nothing placed yet', () => {
    page.render({
      // A cut draw, nothing placed: every fixture is table-less.
      tournament: buildTournament({ events: [buildDrawnEvent()] }),
      tables: buildTables(),
    })
    page.setView('Gantt')

    expect(page.boardEmpty.queryEmpty()).toBeInTheDocument()
    expect(page.boardEmpty.getEmpty()).toHaveTextContent(
      'Run the scheduler to place every match on a table',
    )
    expect(page.gantt.queryBoard()).not.toBeInTheDocument()
  })

  it('offers no view toggle when there is nothing to schedule at all', () => {
    page.render({
      tournament: buildTournament({ events: [buildDrawnEvent({ fixtures: [] })] }),
      tables: buildTables(),
    })
    expect(page.queryViewToggle()).not.toBeInTheDocument()
  })

  // ----- the solve strip on the tab (ADR "the schedule is solved") ------------

  it('renders the solve strip from the tournament’s latest solve', () => {
    page.render({
      tournament: buildTournament({
        events: [buildScheduledEvent()],
        latestScheduleSolve: buildScheduleSolve({ verdict: 'optimal' }),
      }),
      tables: buildTables(),
    })
    expect(page.queryStripState('succeeded')).toBeInTheDocument()
    expect(page.getSolveStrip()).toHaveTextContent('Best possible plan')
  })

  it('keeps the strip on screen over the EMPTY schedule — where the owner meets "cut a draw first"', () => {
    page.render({
      tournament: buildTournament({ events: [buildDrawnEvent({ fixtures: [] })] }),
      tables: buildTables(),
    })
    expect(page.getTab()).toHaveTextContent('Nothing to schedule yet')
    expect(page.queryStripState('none')).toBeInTheDocument()
    expect(page.queryRunScheduler()).toBeInTheDocument()
  })

  it('fires the solve request from the Run-scheduler button, disabling it while in the air', async () => {
    let posts = 0
    let seenUrl = ''
    mockScheduleSolveEndpoint(server, ({ request }) => {
      posts += 1
      seenUrl = request.url
      return HttpResponse.json(
        buildScheduleSolveRead({ status: 'queued', verdict: null }),
        { status: 202 },
      )
    })

    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })

    page.clickRunScheduler()
    // The in-flight guard: the button is dead while the request is out (#436 family).
    expect(page.getRunScheduler()).toBeDisabled()

    await waitFor(() => expect(posts).toBe(1))
    expect(seenUrl).toContain('/v1/tournaments/bay-area-open-2026/schedule/solves')
  })

  it('shows the designed "cut a draw first" message inline when the server answers the coded 422', async () => {
    mockScheduleSolveEndpoint(server, () =>
      HttpResponse.json(
        { detail: { code: 'no_drawn_events', message: 'Nothing is drawn.' } },
        { status: 422 },
      ),
    )

    page.render({
      tournament: buildTournament({ events: [buildDrawnEvent({ fixtures: [] })] }),
      tables: buildTables(),
    })

    page.clickRunScheduler()

    await waitFor(() => expect(page.queryRunNotice()).toBeInTheDocument())
    expect(page.queryRunNotice()).toHaveTextContent('Nothing to schedule yet')
    expect(page.queryRunNotice()).toHaveTextContent("Cut at least one event's draw")
  })

  it('withholds the button while the latest solve is already in flight', () => {
    page.render({
      tournament: buildTournament({
        events: [buildScheduledEvent()],
        latestScheduleSolve: buildScheduleSolve({
          status: 'queued',
          verdict: null,
          finishedAt: null,
          wallTimeMs: null,
          fixturesPlaced: null,
          fixturesPinned: null,
        }),
      }),
      tables: buildTables(),
    })
    expect(page.queryStripState('solving')).toBeInTheDocument()
    expect(page.getRunScheduler()).toBeDisabled()
  })
})
