import { WITHDRAWN_LABEL } from './draw'
import {
  buildEntrants,
  buildEventResults,
  buildReservation,
  buildGroupStandings,
  buildStandingRow,
  buildStandingsEvent,
  standingsResultsOf,
} from './seed.factory'
import { eventStandings } from './standings'
import type { TournamentEvent } from './types'

/** The view for an event's own standings block — the pairing `ResultsPanel` makes at
 * runtime, since the selector is handed the block rather than finding one. (There is no
 * "no results" case to test here any more: the selector takes a `StandingsResults`, so
 * that state cannot be expressed. `ResultsPanel` owns it.) */
const viewOf = (event: TournamentEvent) =>
  eventStandings(event, standingsResultsOf(event))

describe('eventStandings', () => {
  it('joins each row’s entry id to a username, and titles each group by its position — never a stored name', () => {
    const view = viewOf(buildStandingsEvent())

    expect(view.groups).toHaveLength(1)
    expect(view.groups[0].label).toBe('Group A')
    expect(view.groups[0].rows.map((r) => r.name)).toEqual([
      'player.1',
      'player.4',
      'player.5',
    ])
  })

  it('carries every server number and order through untouched', () => {
    // The client shows the figures, it does not compute them (ADR-0788). Feed rows out of
    // finishing order and expect them back in that same order, numbers intact.
    const view = viewOf(
      buildStandingsEvent({
        results: buildEventResults({
          groups: [
            buildGroupStandings({
              rows: [
                buildStandingRow({ entryId: 'entry-5', rank: 3, gameDifference: -3 }),
                buildStandingRow({ entryId: 'entry-1', rank: 1, gameDifference: 3 }),
              ],
            }),
          ],
        }),
      }),
    )

    expect(view.groups[0].rows.map((r) => r.entryId)).toEqual(['entry-5', 'entry-1'])
    expect(view.groups[0].rows.map((r) => r.gameDifference)).toEqual([-3, 3])
  })

  it('joins the champion to a name', () => {
    const view = viewOf(buildStandingsEvent())

    expect(view.complete).toBe(true)
    expect(view.champion).toBe('player.1')
  })

  it('keeps a null champion null — a live or multi-group event', () => {
    const view = viewOf(
      buildStandingsEvent({
        results: buildEventResults({ complete: false, champion: null }),
      }),
    )

    expect(view.champion).toBeNull()
  })

  it('shows a row naming a no-longer-listed entry as Withdrawn', () => {
    // A player who withdrew after playing: their completed matches still count toward the
    // numbers, but they are no longer an entrant, so the join has no username. It is the
    // withdrawn word, never a blank and never the raw id — shared with the draw.
    const view = viewOf(
      buildStandingsEvent({
        entrants: buildEntrants(4), // entry-5 is gone
        results: buildEventResults({
          groups: [
            buildGroupStandings({
              rows: [buildStandingRow({ entryId: 'entry-5', rank: 1 })],
            }),
          ],
        }),
      }),
    )

    expect(view.groups[0].rows[0].name).toBe(WITHDRAWN_LABEL)
  })

  it('falls back to the group id if the event does not list the group', () => {
    // A group the standings name but the event does not carry is a payload the server
    // cannot send; the fallback keeps the table titled rather than blank if it ever did.
    const view = viewOf(
      buildStandingsEvent({
        reservations: [buildReservation({ id: 'res-a', name: 'Reservation A' })],
        results: buildEventResults({
          groups: [buildGroupStandings({ groupId: 'grp-ghost' })],
        }),
      }),
    )

    expect(view.groups[0].label).toBe('grp-ghost')
  })
})
