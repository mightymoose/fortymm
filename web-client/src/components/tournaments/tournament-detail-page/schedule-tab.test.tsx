import { HttpResponse } from 'msw'

import { waitFor, within } from '@/test/utilities'
import { mockFixturePlacementEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentFixtureRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'

import {
  buildDrawnEvent,
  buildFixture,
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
  // interactive controls (no placement control, not a disabled one).
  it('renders no interactive controls for a non-owner', () => {
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
    expect(page.getControls()).toHaveLength(0)
  })
})
