import { HttpResponse } from 'msw'

import { waitFor, within } from '@/test/utilities'
import {
  mockFixturePlacementEndpoint,
  mockScheduleSolveEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import {
  mockSchedulePreviewCancelEndpoint,
  mockSchedulePreviewEnqueueEndpoint,
  mockSchedulePreviewPollEndpoint,
} from '@/mocks/endpoints/tournaments/preview.endpoint'
import {
  buildScheduleSolveRead,
  buildTournamentFixtureRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import {
  buildPreviewEnqueued,
  buildPreviewJobState,
} from '@/mocks/factories/tournaments/preview.factory'
import { server } from '@/mocks/server'
import { schedulePreviewModalPage } from './schedule-preview-modal.page'

import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildFixture,
  buildScheduleSolve,
  buildTables,
  buildTournament,
  groupIdFor,
} from '../data/seed.factory'
import type { ScheduleSolve, ScheduleSolveTrigger } from '../data/solve'
import type { Tournament } from '../data/types'
import { scheduleTabPage as page } from './schedule-tab.page'

/** A drawn event with one match PLACED on table `t1` (in progress) and one still
 * awaiting a table — the two groups the schedule sorts fixtures into. */
const buildScheduledEvent = () =>
  buildDrawnEvent({
    fixtures: [
      buildFixture({
        id: 'fx-a-1',
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

    // The placed match sits in its table's column, named — not a mock reservation window.
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

  it('keeps the reserved windows visible as context', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    expect(page.queryWindows()).toBeInTheDocument()
  })

  // #1537: the two server-computed stranding flags, surfaced as a plain, neutral note
  // on the match's own row — informational, never an accusation, and shown to every
  // viewer (unlike the placement control just below it, which is `canEdit`-gated).
  describe('the reservation-stranding notes', () => {
    /** A placed, in-progress match under `Reservation A` (`buildDrawnEvent`'s own
     * default name) — the row both notes render on. */
    const buildFlaggedEvent = (
      overrides: Partial<Parameters<typeof buildFixture>[0]> = {},
    ) =>
      buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-a-1',
            groupId: groupIdFor('res-a'),
            tableId: 't1',
            scheduledStart: '2026-06-13T09:00:00',
            matchId: 'm-a-1',
            matchStatus: 'in_progress',
            ...overrides,
          }),
        ],
      })

    it('names the table off its reservation', () => {
      page.render({
        tournament: buildTournament({
          events: [buildFlaggedEvent({ tableOffReservation: true })],
        }),
        tables: buildTables(),
      })
      expect(page.queryOffReservationNote('fx-a-1')).toHaveTextContent(
        "This table isn't part of Reservation A's reservation.",
      )
      expect(page.queryOutsideWindowNote('fx-a-1')).not.toBeInTheDocument()
    })

    it('names the time outside its reservation window', () => {
      page.render({
        tournament: buildTournament({
          events: [buildFlaggedEvent({ startOutsideReservationWindow: true })],
        }),
        tables: buildTables(),
      })
      expect(page.queryOutsideWindowNote('fx-a-1')).toHaveTextContent(
        "This time is outside Reservation A's reservation window.",
      )
      expect(page.queryOffReservationNote('fx-a-1')).not.toBeInTheDocument()
    })

    it('shows BOTH notes on one row, legibly, when both axes are flagged', () => {
      page.render({
        tournament: buildTournament({
          events: [
            buildFlaggedEvent({
              tableOffReservation: true,
              startOutsideReservationWindow: true,
            }),
          ],
        }),
        tables: buildTables(),
      })
      // Neither note hides the other — both render, each its own node.
      expect(page.queryOffReservationNote('fx-a-1')).toBeInTheDocument()
      expect(page.queryOutsideWindowNote('fx-a-1')).toBeInTheDocument()
    })

    it('shows neither note when the flags are not applicable (the ordinary case)', () => {
      page.render({
        tournament: buildTournament({ events: [buildFlaggedEvent()] }),
        tables: buildTables(),
      })
      expect(page.queryOffReservationNote('fx-a-1')).not.toBeInTheDocument()
      expect(page.queryOutsideWindowNote('fx-a-1')).not.toBeInTheDocument()
    })

    it('renders the notes for a NON-OWNER too — unlike the placement control, this is not canEdit-gated', () => {
      page.render({
        tournament: buildTournament({
          events: [buildFlaggedEvent({ tableOffReservation: true })],
          canEdit: false,
        }),
        tables: buildTables(),
      })
      expect(page.queryOffReservationNote('fx-a-1')).toBeInTheDocument()
      // The control really is gone for this viewer — proves the note isn't riding
      // along inside it.
      expect(page.queryPlaceTrigger('fx-a-1')).not.toBeInTheDocument()
    })

    // A table can be off its reservation for TWO different reasons that must not be
    // conflated: (1) it is a real table, just not part of this reservation's slice of
    // the venue, or (2) it left the tournament's table catalogue entirely — a dangling
    // ref, which already gets its own "Removed from the catalogue" label
    // (`TableColumn`). Only case 2 is suppressed here; the window note is unaffected.
    it('suppresses the off-reservation note for a table removed from the catalogue — "Removed from the catalogue" already says so', () => {
      page.render({
        tournament: buildTournament({
          events: [
            buildFlaggedEvent({
              tableId: 't-removed',
              tableOffReservation: true,
              startOutsideReservationWindow: true,
            }),
          ],
        }),
        // The catalogue this tournament actually holds — `t-removed` is not in it.
        tables: buildTables(),
      })
      expect(page.getTableColumn('t-removed')).toHaveTextContent(
        'Removed from the catalogue',
      )
      expect(page.queryOffReservationNote('fx-a-1')).not.toBeInTheDocument()
      // The window note is a fact about the TIME, not the table — it still shows.
      expect(page.queryOutsideWindowNote('fx-a-1')).toBeInTheDocument()
    })
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
    // The naive timestamp is composed from the reservation window's DATE + the chosen time
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
    // (its reservation's first suggested table, `t1`) with no prediction, never a composed
    // `YYYY-MM-DDT:00`.
    expect(sent).toMatchObject({ table_id: 't1', scheduled_start: null })
  })

  // ----- an EVENT-WIDE match on the schedule tab (ADR 20260807, "a reservation
  // restricts scheduling, it does not enable it"). A bracket, a swiss round and a
  // knockout stage carry no reservation (they are ungrouped), so they are placed
  // against their EVENT's own window over the WHOLE tournament's tables. The
  // booked-reservation behaviour underneath must not move: a reservation must still
  // restrict. -----------------------------------------------

  /** A single-elim bracket (`groups: []`, every fixture `groupId: null`) whose event
   * window is the tournament's SECOND day. The date is deliberately not the reservation
   * default (`2026-06-13`, which `buildReservation` and `buildEvent` share): a bracket
   * left on it could not tell "composed from the event window" from "composed from some
   * reservation's window". */
  const buildUngroupedEvent = () =>
    buildBracketDrawnEvent({
      slot: { date: '2026-06-14', start: '10:00', end: '16:00' },
    })

  it('places an EVENT-WIDE match against its EVENT window’s date, on a tournament table', async () => {
    let sent: unknown = null
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-se-r1-p1',
          table_id: 't3',
          scheduled_start: '2026-06-14T14:00:00',
        }),
      )
    })

    page.render({
      // The tournament reserves t3…t5 out of a t1…t12 catalogue, on purpose. With the
      // default t1-first reservation the suggestion and the catalogue's first table are
      // the same `t1`, so the pre-selected table could not tell "offered the
      // tournament's own tables" from "fell back to the first table that exists".
      tournament: buildTournament({
        tableIds: ['t3', 't4', 't5'],
        events: [buildUngroupedEvent()],
      }),
      tables: buildTables(),
    })

    page.openPlacement('fx-se-r1-p1')
    page.setPlaceTime('fx-se-r1-p1', '14:00')
    page.savePlacement('fx-se-r1-p1')

    await waitFor(() =>
      expect(page.queryPlaceEditor('fx-se-r1-p1')).not.toBeInTheDocument(),
    )
    // The DATE is the event window's, and the TABLE is the tournament's first reserved
    // one — an event-wide match is offered the event-wide reservation, not nothing.
    expect(sent).toMatchObject({
      table_id: 't3',
      scheduled_start: '2026-06-14T14:00:00',
    })
  })

  it('marks a BOOKED-RESERVATION match’s own reservation tables, and marks nothing on an event-wide one', () => {
    // Both kinds in ONE tournament, so the mark is proven to discriminate rather
    // than to be on or off everywhere.
    page.render({
      tournament: buildTournament({
        events: [buildScheduledEvent(), buildUngroupedEvent()],
      }),
      tables: buildTables(),
    })

    // Reservation A reserves t1…t4, so the chosen table wears the mark — unchanged.
    page.openPlacement('fx-a-2')
    expect(page.getPlaceTable('fx-a-2')).toHaveTextContent('T1 · reservation table')

    // The bracket match names no reservation. Every table in the tournament is fair
    // game, so a mark on all of them would say nothing — and would claim a reservation
    // that does not exist.
    page.openPlacement('fx-se-r1-p1')
    expect(page.getPlaceTable('fx-se-r1-p1')).toHaveTextContent('T1')
    expect(page.getPlaceTable('fx-se-r1-p1')).not.toHaveTextContent('reservation table')
  })

  it('tells the director where a placement’s date comes from — for a booked-reservation match AND an event-wide one', () => {
    page.render({
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })
    expect(page.getTab()).toHaveTextContent(
      'the date comes from its reservation window, or from its event window when it has no reservation',
    )
  })

  it('leaves the non-owner’s subtitle alone — it never claimed a reservation', () => {
    page.render({
      tournament: buildTournament({
        canEdit: false,
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    expect(page.getTab()).toHaveTextContent(
      'Every match, by table, with its predicted start time.',
    )
    expect(page.getTab()).not.toHaveTextContent('reservation window')
  })

  // ----- the consequence gate on the placement submit path (ADR "the schedule
  // is solved; the call is pinned": while LIVE, placing a fixture IS calling it,
  // so any placement write that would notify is priced by a confirm before the
  // mutation fires; pre-live placements stay silent). ------------------------

  it('places silently pre-live — no dialog, the mutation fires directly (free rearranging while planning)', async () => {
    let patches = 0
    mockFixturePlacementEndpoint(server, () => {
      patches += 1
      return HttpResponse.json(
        buildTournamentFixtureRead({ id: 'fx-a-2', table_id: 't1' }),
      )
    })

    page.render({
      // `published` — the pre-live default.
      tournament: buildTournament({ events: [buildScheduledEvent()] }),
      tables: buildTables(),
    })

    page.openPlacement('fx-a-2')
    page.savePlacement('fx-a-2')

    // No gate: nothing to confirm, the write is already in the air.
    expect(page.callDialog.queryDialog()).not.toBeInTheDocument()
    await waitFor(() => expect(patches).toBe(1))
  })

  it('gates a LIVE placement of an untold fixture behind the CALL confirm — the mutation waits for it', async () => {
    let sent: unknown = null
    let patches = 0
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      patches += 1
      sent = await request.json()
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-a-2',
          table_id: 't1',
          scheduled_start: '2026-06-13T09:00:00',
        }),
      )
    })

    page.render({
      tournament: buildTournament({
        status: 'live',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })

    page.openPlacement('fx-a-2')
    page.savePlacement('fx-a-2')

    // The dialog is up, the call copy names the destination — and NOTHING has
    // been sent yet: the confirm prices the click before it spends anything.
    const dialog = page.callDialog.getDialog()
    expect(dialog).toHaveTextContent('Call this match?')
    expect(dialog).toHaveTextContent('player.1 vs player.5')
    expect(dialog).toHaveTextContent('T1 at 09:00')
    expect(page.callDialog.getConfirmButton()).toHaveTextContent('Call the match')
    expect(patches).toBe(0)

    page.callDialog.confirm()
    await waitFor(() => expect(patches).toBe(1))
    expect(sent).toMatchObject({
      table_id: 't1',
      scheduled_start: '2026-06-13T09:00:00',
    })
    // The editor closes on success, as on the silent path.
    await waitFor(() =>
      expect(page.queryPlaceEditor('fx-a-2')).not.toBeInTheDocument(),
    )
  })

  it('backs out of the confirm without sending anything — the editor keeps the work', async () => {
    let patches = 0
    mockFixturePlacementEndpoint(server, () => {
      patches += 1
      return HttpResponse.json(buildTournamentFixtureRead({ id: 'fx-a-2' }))
    })

    page.render({
      tournament: buildTournament({
        status: 'live',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })

    page.openPlacement('fx-a-2')
    page.savePlacement('fx-a-2')
    expect(page.callDialog.queryDialog()).toBeInTheDocument()

    page.callDialog.cancel()
    await waitFor(() =>
      expect(page.callDialog.queryDialog()).not.toBeInTheDocument(),
    )
    // No mutation fired; the editor is still open with the director's picks.
    expect(patches).toBe(0)
    expect(page.queryPlaceEditor('fx-a-2')).toBeInTheDocument()
  })

  /** A LIVE tournament whose fixture the players have already been told about
   * twice: placed on `t1` at 10:00, pinned, `callNotifiedCount: 2`. */
  const buildLiveToldTournament = () =>
    buildTournament({
      status: 'live',
      events: [
        buildDrawnEvent({
          fixtures: [
            buildFixture({
              id: 'fx-told',
              entryAId: 'entry-1',
              entryBId: 'entry-4',
              tableId: 't1',
              scheduledStart: '2026-06-13T10:00:00',
              pinnedAt: '2026-06-13T09:50:00',
              callNotifiedCount: 2,
            }),
          ],
        }),
      ],
    })

  it('gates a LIVE move of a TOLD fixture behind the stronger correction confirm — the old table named, the count visible', async () => {
    let sent: unknown = null
    let patches = 0
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      patches += 1
      sent = await request.json()
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-told',
          table_id: 't1',
          scheduled_start: '2026-06-13T11:30:00',
        }),
      )
    })

    page.render({ tournament: buildLiveToldTournament(), tables: buildTables() })

    page.openPlacement('fx-told')
    page.setPlaceTime('fx-told', '11:30')
    page.savePlacement('fx-told')

    // The correction copy names what the players were TOLD — the promise being
    // rewritten — and what the calls have already cost them.
    const dialog = page.callDialog.getDialog()
    expect(dialog).toHaveTextContent('Move a called match?')
    expect(dialog).toHaveTextContent('were told T1 at 10:00')
    expect(dialog).toHaveTextContent('T1 at 11:30')
    expect(page.callDialog.queryNotified()).toHaveTextContent('notified 2× already')
    expect(page.callDialog.getConfirmButton()).toHaveTextContent('Move and notify')
    expect(patches).toBe(0)

    page.callDialog.confirm()
    await waitFor(() => expect(patches).toBe(1))
    expect(sent).toMatchObject({ scheduled_start: '2026-06-13T11:30:00' })
  })

  it('gates CLEARING a TOLD fixture (live) behind the cancel-specific confirm — a cancellation notifies too', async () => {
    let sent: unknown = null
    let patches = 0
    mockFixturePlacementEndpoint(server, async ({ request }) => {
      patches += 1
      sent = await request.json()
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-told',
          table_id: null,
          scheduled_start: null,
        }),
      )
    })

    page.render({ tournament: buildLiveToldTournament(), tables: buildTables() })

    page.openPlacement('fx-told')
    page.clearPlacement('fx-told')

    const dialog = page.callDialog.getDialog()
    expect(dialog).toHaveTextContent('Cancel this call?')
    expect(dialog).toHaveTextContent('were told T1 at 10:00')
    expect(dialog).toHaveTextContent('the match is off this table')
    expect(page.callDialog.getConfirmButton()).toHaveTextContent('Cancel the call')
    expect(patches).toBe(0)

    page.callDialog.confirm()
    await waitFor(() => expect(patches).toBe(1))
    expect(sent).toMatchObject({ table_id: null, scheduled_start: null })
  })

  it('clears an UNTOLD placement silently even while live — nobody was promised anything', async () => {
    let patches = 0
    mockFixturePlacementEndpoint(server, () => {
      patches += 1
      return HttpResponse.json(
        buildTournamentFixtureRead({
          id: 'fx-a-1',
          table_id: null,
          scheduled_start: null,
        }),
      )
    })

    page.render({
      tournament: buildTournament({
        status: 'live',
        events: [
          buildDrawnEvent({
            fixtures: [
              // Placed pre-live (an estimate — count 0), tournament now live.
              buildFixture({
                id: 'fx-a-1',
                entryAId: 'entry-1',
                entryBId: 'entry-4',
                tableId: 't1',
                scheduledStart: '2026-06-13T09:00:00',
              }),
            ],
          }),
        ],
      }),
      tables: buildTables(),
    })

    page.openPlacement('fx-a-1')
    page.clearPlacement('fx-a-1')

    expect(page.callDialog.queryDialog()).not.toBeInTheDocument()
    await waitFor(() => expect(patches).toBe(1))
  })

  it('does not offer to move a finished match (its placement is frozen)', () => {
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-done',
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
   * twice-notified call at 10:00, and a called (told once) in-progress match at
   * 11:00 — the shape every live round-robin holds, since go-live materializes
   * each fixture into an `in_progress` match. */
  const buildTieredEvent = () =>
    buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-est',
          entryAId: 'entry-1',
          entryBId: 'entry-4',
          tableId: 't1',
          scheduledStart: '2026-06-13T09:00:00',
        }),
        buildFixture({
          id: 'fx-called',
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
          round: 3,
          entryAId: 'entry-4',
          entryBId: 'entry-5',
          matchId: 'm-live',
          matchStatus: 'in_progress',
          tableId: 't1',
          scheduledStart: '2026-06-13T11:00:00',
          pinnedAt: '2026-06-13T10:50:00',
          callNotifiedCount: 1,
        }),
      ],
    })

  it('marks a scheduled estimate `est` on its list row — and only an estimate', () => {
    page.render({
      tournament: buildTournament({ events: [buildTieredEvent()] }),
      tables: buildTables(),
    })
    expect(page.getMatch('fx-est')).toHaveTextContent('9:00 AM CDT · est')
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
    expect(page.getCalledBadge('fx-called')).toHaveTextContent('Called 9:50 AM CDT')
    expect(page.queryNotified('fx-called')).toHaveTextContent('notified 2×')
    // The estimate has promised nothing.
    expect(page.queryCalledBadge('fx-est')).not.toBeInTheDocument()
    expect(page.queryNotified('fx-est')).not.toBeInTheDocument()
  })

  it('keeps the badge on a TOLD in_progress row — materialization must not hide the promise', () => {
    // The QA-caught gap: go-live materializes EVERY round-robin fixture into
    // an `in_progress` match, so a called match is tier `started` from the
    // first live second — and the badge used to vanish with the tier, leaving
    // the director unable to see which matches were called.
    page.render({
      tournament: buildTournament({ events: [buildTieredEvent()] }),
      tables: buildTables(),
    })
    expect(page.getCalledBadge('fx-live')).toHaveTextContent('Called 10:50')
    // Told once — no correction yet, so no counter.
    expect(page.queryNotified('fx-live')).not.toBeInTheDocument()
  })

  it('retires the badge once the match is decided — no stale call marker on a completed row', () => {
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-done',
                entryAId: 'entry-1',
                entryBId: 'entry-4',
                matchId: 'm-done',
                matchStatus: 'completed',
                tableId: 't1',
                scheduledStart: '2026-06-13T10:00:00',
                pinnedAt: '2026-06-13T09:50:00',
                callNotifiedCount: 2,
              }),
            ],
          }),
        ],
      }),
      tables: buildTables(),
    })
    expect(page.queryCalledBadge('fx-done')).not.toBeInTheDocument()
    expect(page.queryNotified('fx-done')).not.toBeInTheDocument()
    expect(page.getStatus('fx-done')).toHaveTextContent('Completed')
  })

  it('badges a pinned-untold in_progress row `Pinned` — the pin holds through materialization, claiming no call', () => {
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-pin-live',
                entryAId: 'entry-1',
                entryBId: 'entry-4',
                matchId: 'm-pin-live',
                matchStatus: 'in_progress',
                tableId: 't1',
                scheduledStart: '2026-06-13T10:00:00',
                pinnedAt: '2026-06-13T09:50:00',
                callNotifiedCount: 0,
              }),
            ],
          }),
        ],
      }),
      tables: buildTables(),
    })
    const badge = page.getCalledBadge('fx-pin-live')
    expect(badge).toHaveTextContent('Pinned')
    expect(badge).not.toHaveTextContent('Called')
    expect(page.queryNotified('fx-pin-live')).not.toBeInTheDocument()
  })

  it('badges a SILENT pin `Pinned` — never `Called`, never a notified claim (pinned is not told)', () => {
    // Every full manual placement pins, pre-live included; live only gates the
    // notify. A pin with a count of 0 is the director's silent pre-live hand —
    // the row must not claim a call time or a notification nobody received.
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-silent-pin',
                entryAId: 'entry-1',
                entryBId: 'entry-4',
                tableId: 't1',
                scheduledStart: '2026-06-13T10:00:00',
                pinnedAt: '2026-06-13T09:50:00',
                callNotifiedCount: 0,
              }),
            ],
          }),
        ],
      }),
      tables: buildTables(),
    })
    const badge = page.getCalledBadge('fx-silent-pin')
    expect(badge).toHaveTextContent('Pinned')
    expect(badge).not.toHaveTextContent('Called')
    expect(page.queryNotified('fx-silent-pin')).not.toBeInTheDocument()
    // The pinned time is firm, not an estimate — no `est` mark either.
    expect(page.queryEst('fx-silent-pin')).not.toBeInTheDocument()
  })

  it('keeps the notified counter off a once-called row — one call is the ordinary case', () => {
    page.render({
      tournament: buildTournament({
        events: [
          buildDrawnEvent({
            fixtures: [
              buildFixture({
                id: 'fx-called-once',
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
    expect(page.getCalledBadge('fx-called-once')).toHaveTextContent('Called 9:50 AM CDT')
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

  // ----- the pre-live "Preview schedule" trigger (ADR "a schedule preview is a
  // non-persistent solve over a synthetic field": owner-gated, allowed only while
  // the tournament is pre-live — `draft` or `published` — and refused on
  // `live`/`archived`). The affordance is hidden, never disabled (ADR-0015). The
  // gating is a truth table over owner × status. ------------------------------

  it('offers the owner the preview trigger on a DRAFT tournament', () => {
    page.render({
      tournament: buildTournament({
        status: 'draft',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    expect(page.queryPreviewTrigger()).toBeInTheDocument()
    // Closed until clicked — the modal has not mounted, nothing has been enqueued.
    expect(page.queryPreviewModal()).not.toBeInTheDocument()
  })

  it('offers the owner the preview trigger on a PUBLISHED tournament', () => {
    page.render({
      tournament: buildTournament({
        status: 'published',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    expect(page.queryPreviewTrigger()).toBeInTheDocument()
  })

  it('offers a NON-OWNER no preview trigger, even pre-live', () => {
    page.render({
      tournament: buildTournament({
        canEdit: false,
        status: 'draft',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    expect(page.queryPreviewTrigger()).not.toBeInTheDocument()
  })

  it('offers the owner no preview trigger once the tournament is LIVE', () => {
    page.render({
      tournament: buildTournament({
        status: 'live',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    expect(page.queryPreviewTrigger()).not.toBeInTheDocument()
  })

  it('offers the owner no preview trigger once the tournament is ARCHIVED', () => {
    page.render({
      tournament: buildTournament({
        status: 'archived',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })
    expect(page.queryPreviewTrigger()).not.toBeInTheDocument()
  })

  it('opens the preview modal when the owner clicks the trigger', async () => {
    // The modal enqueues on open (and cancels on close): stub the three ephemeral
    // preview endpoints so the click resolves deterministically to the instant
    // structure rather than the default store.
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(buildPreviewEnqueued(), { status: 202 }),
    )
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(buildPreviewJobState({ status: 'queued' })),
    )
    mockSchedulePreviewCancelEndpoint(server, () => new HttpResponse(null, { status: 204 }))

    page.render({
      tournament: buildTournament({
        status: 'draft',
        events: [buildScheduledEvent()],
      }),
      tables: buildTables(),
    })

    expect(page.queryPreviewModal()).not.toBeInTheDocument()
    page.openPreview()

    // The dialog is up, and its instant structure streams in from the enqueue 202 —
    // proving it really mounted the preview modal, not just any dialog.
    expect(page.queryPreviewModal()).toBeInTheDocument()
    await schedulePreviewModalPage.findFieldSummary()
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

  // ----- the provisional-placement contract (#1614): while the latest solve is
  // `queued`/`running`, the placements on screen are the server's LAST ACCEPTED
  // plan — the go-live transition commits matches and enqueues the solve before
  // the worker applies its placements, and every other trigger shares the same
  // asynchronous window. The tab must render that data as an update in progress
  // (never as a finalized schedule) and withhold Place/Move, until a terminal
  // payload — which the poll carries in without a reload — restores them. -----

  /** A LIVE tournament with one placed fixture (on `t1`) and one awaiting — the
   * go-live shape: materialized matches, placements possibly still in flight. */
  const buildLivePartlyPlaced = (
    solve: ScheduleSolve,
    overrides: Partial<Tournament> = {},
  ) =>
    buildTournament({
      status: 'live',
      latestScheduleSolve: solve,
      events: [
        buildDrawnEvent({
          fixtures: [
            buildFixture({
              id: 'fx-placed',
              entryAId: 'entry-1',
              entryBId: 'entry-4',
              matchId: 'm-placed',
              matchStatus: 'in_progress',
              tableId: 't1',
              scheduledStart: '2026-06-13T09:00:00',
            }),
            buildFixture({
              id: 'fx-unplaced',
              round: 2,
              entryAId: 'entry-1',
              entryBId: 'entry-5',
            }),
          ],
        }),
      ],
      ...overrides,
    })

  /** An in-flight solve — `queued` or `running` — with the stage fields a run
   * that has not finished has not reached, and the trigger naming what caused
   * it (every trigger shares the provisional window). */
  const buildInFlightSolve = (
    status: 'queued' | 'running',
    trigger: ScheduleSolveTrigger = 'go_live',
  ) =>
    buildScheduleSolve({
      trigger,
      status,
      verdict: null,
      startedAt: status === 'running' ? '2026-06-13T09:00:01Z' : null,
      finishedAt: null,
      wallTimeMs: null,
      fixturesPlaced: null,
      fixturesPinned: null,
    })

  it.each(['queued', 'running'] as const)(
    'treats the rendered placements as an update in progress while the solve is %s — notice up, last-good schedule kept, Place/Move withheld',
    (status) => {
      page.render({
        tournament: buildLivePartlyPlaced(buildInFlightSolve(status)),
        tables: buildTables(),
      })

      // The visible provisional treatment, for owner and viewer alike.
      expect(page.getPlacementUpdating()).toHaveTextContent(
        'Placement updates in progress',
      )
      // The last-good schedule is still on screen — provisional, not hidden.
      expect(page.matchIdsIn(page.getTableColumn('t1'))).toEqual(['fx-placed'])
      expect(page.matchIdsIn(page.getAwaiting())).toEqual(['fx-unplaced'])
      // And it is NOT actionable: no Place on the awaiting row, no Move on the
      // placed one — acting on either would act on data a landing solve may
      // replace.
      expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
      expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()
    },
  )

  // The review's P1 on #1618: between the click on Run scheduler and the settle
  // refetch, the `tournament` prop still carries the previous terminal solve —
  // and the gate must close across that window. Two bridges, pinned separately:
  // the request itself (this test) and the 202 row the mutation caches into the
  // detail entry (the data-layer test in `api.hooks.test`).
  it('closes the gate while the run request is in the air, on a prop that still holds the previous terminal solve', async () => {
    // A POST the test holds in the air, so the in-flight window is observable.
    let release: () => void = () => {}
    let posts = 0
    mockScheduleSolveEndpoint(
      server,
      () =>
        new Promise((resolve) => {
          posts += 1
          release = () =>
            resolve(
              HttpResponse.json(
                buildScheduleSolveRead({
                  status: 'queued',
                  verdict: null,
                  started_at: null,
                  finished_at: null,
                  wall_time_ms: null,
                  fixtures_placed: null,
                  fixtures_pinned: null,
                }),
                { status: 202 },
              ),
            )
        }),
    )

    page.render({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ trigger: 'manual', verdict: 'feasible' }),
      ),
      tables: buildTables(),
    })
    // A terminal solve: the actions are live right up to the click.
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
    expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')

    page.clickRunScheduler()

    // The request is out and the prop still holds the previous terminal solve
    // — yet the gate is closed: the notice is up and Place/Move are withheld.
    await waitFor(() => {
      expect(posts).toBe(1)
      expect(page.getPlacementUpdating()).toBeInTheDocument()
    })
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()

    // The 202 lands (the accepted queued run — `./api` caches it into the
    // detail entry, where the real tab reads it). Nothing else to prove here,
    // so let the pending chain settle.
    release()
    // Settled: the harness's prop still holds the terminal solve, so the
    // in-flight latch alone (the strip's) ends and the button relights — the
    // cached-queued-row bridge is proven at the data layer (`api.hooks.test`).
    await waitFor(() => expect(page.getRunScheduler()).toBeEnabled())
  })

  // The #1614 review's terminal-row case: a small solve can finish before the
  // POST serializes (and an absorbed request can return its just-finished run),
  // so the 202's row can already be TERMINAL. Merging it would pair a solved
  // ledger with pre-solve fixtures, so `./api` stands the cache write down and
  // the tab latches the snapshot the click happened on, holding the gate until
  // a detail payload — which reads the solve and its fixtures together — lands.
  it('keeps the gate closed when the POST itself returns a terminal solve, until a payload reconciles it', async () => {
    let release: () => void = () => {}
    let posts = 0
    mockScheduleSolveEndpoint(
      server,
      () =>
        new Promise((resolve) => {
          posts += 1
          release = () =>
            resolve(
              HttpResponse.json(
                buildScheduleSolveRead({
                  id: 'solve-2',
                  status: 'succeeded',
                  verdict: 'optimal',
                }),
                { status: 202 },
              ),
            )
        }),
    )

    page.render({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ trigger: 'manual', verdict: 'feasible' }),
      ),
      tables: buildTables(),
    })
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')

    page.clickRunScheduler()
    await waitFor(() => expect(posts).toBe(1))
    release()
    // The request has settled (the strip's latch is off and the button
    // relights) — but the terminal 202 row merged nowhere, so the gate still
    // holds: the notice stays up and Place/Move stay withheld.
    await waitFor(() => expect(page.getRunScheduler()).toBeEnabled())
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()

    // The reconciling payload — ONE detail read carrying the terminal row and
    // the fixtures it placed — retires the latch and restores the actions.
    page.rerender({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ id: 'solve-2', trigger: 'manual' }),
      ),
    })
    expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
    expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')
  })

  // The same case where the absorbed request's rerun is ALREADY queued: the
  // reconciling payload then carries a queued row, which keeps the gate shut on
  // its own, and only the rerun's own terminal payload opens it.
  it('holds the gate through the rerun a queued-behind POST leaves in flight', async () => {
    let release: () => void = () => {}
    let posts = 0
    mockScheduleSolveEndpoint(
      server,
      () =>
        new Promise((resolve) => {
          posts += 1
          release = () =>
            resolve(
              HttpResponse.json(
                buildScheduleSolveRead({
                  id: 'solve-2',
                  status: 'succeeded',
                  verdict: 'optimal',
                }),
                { status: 202 },
              ),
            )
        }),
    )

    page.render({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ trigger: 'manual', verdict: 'feasible' }),
      ),
      tables: buildTables(),
    })
    page.clickRunScheduler()
    await waitFor(() => expect(posts).toBe(1))
    release()
    await waitFor(() => expect(page.getRunScheduler()).toBeEnabled())

    // First payload after the acceptance: the rerun (solve-3) the server
    // enqueued behind the absorbed request — still `queued`, so the gate holds.
    page.rerender({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({
          id: 'solve-3',
          trigger: 'rerun',
          status: 'queued',
          verdict: null,
          startedAt: null,
          finishedAt: null,
          wallTimeMs: null,
          fixturesPlaced: null,
          fixturesPinned: null,
        }),
      ),
    })
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()

    // The rerun lands terminal: its payload reconciles, the actions return.
    page.rerender({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({
          id: 'solve-3',
          trigger: 'rerun',
          status: 'succeeded',
          verdict: 'optimal',
        }),
      ),
    })
    expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
    expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')
  })

  // The #1614 review's ambiguous-failure case: the route commits the run
  // BEFORE it answers, so the POST can fail (a lost transport, a 5xx from a
  // proxy) while the queue accepted the run. The success-only latch never
  // arms and no in-flight row is cached — so the tab latches the snapshot
  // itself (`runOutcomeAmbiguous`), holding the gate shut past `isPending`
  // until a successful detail read reconciles it.
  it('keeps the gate closed when the POST fails ambiguously (a proxy 5xx), until a payload reconciles it', async () => {
    let release: () => void = () => {}
    let posts = 0
    mockScheduleSolveEndpoint(
      server,
      () =>
        new Promise((resolve) => {
          posts += 1
          release = () =>
            resolve(
              HttpResponse.json({ detail: 'bad gateway' }, { status: 502 }),
            )
        }),
    )

    page.render({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ trigger: 'manual', verdict: 'feasible' }),
      ),
      tables: buildTables(),
    })
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')

    page.clickRunScheduler()
    await waitFor(() => expect(posts).toBe(1))
    release()
    // The request settled on an "error" the server never actually stated —
    // the strip shows its generic notice, but the gate still holds: the
    // notice is up and Place/Move stay withheld.
    await waitFor(() => expect(page.getRunScheduler()).toBeEnabled())
    expect(page.queryRunNotice()).toBeInTheDocument()
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()

    // The first reconciling read carries the run the queue actually
    // accepted (the worker, not the request, failed) — still in flight, so
    // the gate holds on the payload's own account.
    page.rerender({
      tournament: buildLivePartlyPlaced(buildInFlightSolve('queued', 'manual')),
    })
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()

    // The run lands terminal: the reconciled truth, actions restored.
    page.rerender({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ id: 'solve-2', trigger: 'manual' }),
      ),
    })
    expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
    expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')
  })

  // The #1618 P2 follow-up: a status-0 failure may mean the POST never reached
  // the API. Its settle refetch then succeeds with a detail payload exactly
  // equal to the cached one. Production structural sharing preserves the
  // selected `tournament` object in that case, but the successful read still
  // reconciles the ambiguity and must retire the latch.
  it('releases the ambiguous-failure latch after an equal detail read', async () => {
    let release: () => void = () => {}
    let posts = 0
    mockScheduleSolveEndpoint(
      server,
      () =>
        new Promise((resolve) => {
          posts += 1
          release = () => resolve(HttpResponse.error())
        }),
    )

    const tournament = buildLivePartlyPlaced(
      buildScheduleSolve({ trigger: 'manual', verdict: 'feasible' }),
    )
    page.render({ tournament, tables: buildTables() })

    page.clickRunScheduler()
    await waitFor(() => expect(posts).toBe(1))
    release()
    await waitFor(() => expect(page.getRunScheduler()).toBeEnabled())
    expect(page.getPlacementUpdating()).toBeInTheDocument()

    // A successful GET returned equal data, so structural sharing handed the
    // component the exact same selected object. Fetch completion — not object
    // identity — is what releases the latch.
    page.rerender({ tournament })
    expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
    expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')
  })

  // The contrast the classification exists for: a DEFINITE refusal — the
  // documented 503, "the queue could not be reached, so nothing was queued" —
  // answers the click, so the gate releases with it. No latch, no lingering
  // notice beyond the strip's own, and the pre-click placements are the truth.
  it('releases the gate when the POST is definitely refused (the documented 503)', async () => {
    let release: () => void = () => {}
    let posts = 0
    mockScheduleSolveEndpoint(
      server,
      () =>
        new Promise((resolve) => {
          posts += 1
          release = () =>
            resolve(
              HttpResponse.json(
                {
                  detail:
                    'The scheduling queue is unavailable, so the solve was not queued. Try again in a moment.',
                },
                { status: 503 },
              ),
            )
        }),
    )

    page.render({
      tournament: buildLivePartlyPlaced(
        buildScheduleSolve({ trigger: 'manual', verdict: 'feasible' }),
      ),
      tables: buildTables(),
    })
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')

    page.clickRunScheduler()
    await waitFor(() => expect(posts).toBe(1))
    release()
    // The refusal notice is up — and the gate is OPEN the moment the request
    // settles: nothing was queued, so the placements on screen stand.
    await waitFor(() => expect(page.getRunScheduler()).toBeEnabled())
    expect(page.queryRunNotice()).toHaveTextContent(
      'The scheduler is unavailable right now',
    )
    expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
    expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
    expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')
  })

  it.each([
    'go_live',
    'match_completed',
    'settings_changed',
    'manual',
    'pin_tick',
    'rerun',
  ] as const)(
    'withholds placement actions for a %s solve too — every trigger shares the provisional window',
    (trigger) => {
      page.render({
        tournament: buildLivePartlyPlaced(buildInFlightSolve('queued', trigger)),
        tables: buildTables(),
      })
      expect(page.getPlacementUpdating()).toBeInTheDocument()
      expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
      expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()
    },
  )

  it('shows a non-owner the in-progress notice and no editing controls — the provisional state is a view too (ADR-0015)', () => {
    page.render({
      tournament: buildLivePartlyPlaced(buildInFlightSolve('running'), {
        canEdit: false,
      }),
      tables: buildTables(),
    })
    // The in-progress state is visible to a viewer…
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    // …and the sweep proves the notice introduced no control of its own.
    expect(page.getEditingControls()).toHaveLength(0)
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
  })

  it.each(['succeeded', 'infeasible', 'failed'] as const)(
    'restores placement actions once the solve lands %s — and takes the notice down',
    (status) => {
      page.render({
        tournament: buildLivePartlyPlaced(buildInFlightSolve('queued')),
        tables: buildTables(),
      })
      expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()

      // The poll lands the terminal row: one fresh detail payload, the tab
      // re-renders, and the director can place again (an `infeasible`/`failed`
      // outcome leaves the fixtures genuinely unplaced — manual placement is
      // exactly the recovery).
      page.rerender({
        tournament: buildLivePartlyPlaced(
          buildScheduleSolve({ trigger: 'go_live', status }),
        ),
      })
      expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
      expect(page.getPlaceTrigger('fx-unplaced')).toHaveTextContent('Place')
      expect(page.getPlaceTrigger('fx-placed')).toHaveTextContent('Move')
    },
  )

  it('reconciles the open tab to the fresh placements when the go-live solve lands — the race, without a reload', () => {
    // The reported race, in data: the go-live transition commits the live
    // status and materializes the matches BEFORE the worker applies its
    // placements, so the tab's pre-apply snapshot holds a live tournament whose
    // match is `in_progress` but whose fixture is still unplaced — solve queued.
    const raceEvent = (autoPlaced: boolean) =>
      buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-auto',
            entryAId: 'entry-1',
            entryBId: 'entry-4',
            matchId: 'm-auto',
            matchStatus: 'in_progress',
            tableId: autoPlaced ? 't1' : null,
            scheduledStart: autoPlaced ? '2026-06-13T09:00:00' : null,
            pinnedAt: autoPlaced ? '2026-06-13T08:50:00' : null,
            callNotifiedCount: autoPlaced ? 1 : 0,
          }),
          buildFixture({
            id: 'fx-manual',
            round: 2,
            entryAId: 'entry-1',
            entryBId: 'entry-5',
          }),
        ],
      })
    const race = (autoPlaced: boolean, solve: ScheduleSolve) =>
      buildTournament({
        status: 'live',
        latestScheduleSolve: solve,
        events: [raceEvent(autoPlaced)],
      })

    page.render({
      tournament: race(false, buildInFlightSolve('queued')),
      tables: buildTables(),
    })
    // The provisional snapshot: the auto-called match reads as its fixture's
    // last-known placement — still awaiting, still offered (to the owner) the
    // very action this ticket withholds.
    expect(page.matchIdsIn(page.getAwaiting())).toEqual(['fx-auto', 'fx-manual'])
    expect(page.queryTableColumn('t1')).not.toBeInTheDocument()
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-auto')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-manual')).not.toBeInTheDocument()

    // The worker commits; the next poll lands ONE fresh detail payload carrying
    // both the terminal solve and the fixtures it placed. The same open tab
    // recomputes — no reload, no tab change, no navigation.
    page.rerender({
      tournament: race(
        true,
        buildScheduleSolve({ trigger: 'go_live', status: 'succeeded', verdict: 'optimal' }),
      ),
    })

    // The auto-called fixture is under its table — never "Awaiting placement" —
    // and is not offered a Place action (it is placed; its affordance, if read,
    // is Move).
    expect(page.matchIdsIn(page.getTableColumn('t1'))).toEqual(['fx-auto'])
    expect(page.matchIdsIn(page.getAwaiting())).toEqual(['fx-manual'])
    expect(page.getPlaceTrigger('fx-auto')).toHaveTextContent('Move')
    // The genuinely unplaced fixture's manual action is back, and the
    // provisional treatment is gone.
    expect(page.getPlaceTrigger('fx-manual')).toHaveTextContent('Place')
    expect(page.queryPlacementUpdating()).not.toBeInTheDocument()
  })

  it('keeps placement actions withheld when a background refetch fails after an in-flight snapshot', () => {
    // A failed refetch leaves the LAST-GOOD payload in the cache — the tab
    // re-renders with the same queued solve, and the suppression must hold:
    // stale actions must not become available merely because a newer response
    // could not be obtained.
    page.render({
      tournament: buildLivePartlyPlaced(buildInFlightSolve('queued')),
      tables: buildTables(),
    })
    page.rerender({})
    expect(page.getPlacementUpdating()).toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-unplaced')).not.toBeInTheDocument()
    expect(page.queryPlaceTrigger('fx-placed')).not.toBeInTheDocument()
  })
})
