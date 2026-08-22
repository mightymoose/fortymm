import { WITHDRAWN_LABEL } from './draw'
import {
  buildEntrants,
  buildSwissStandingRow,
  buildSwissStandingsEvent,
  buildSwissStandingsResults,
  swissStandingsResultsOf,
} from './seed.factory'
import { eventSwissStandings } from './swiss-standings'
import type { TournamentEvent } from './types'

/** The view for an event's own swiss block — the pairing `ResultsPanel` makes at runtime,
 * since the selector is handed the block rather than finding one. */
const viewOf = (event: TournamentEvent) =>
  eventSwissStandings(event, swissStandingsResultsOf(event))

describe('eventSwissStandings', () => {
  it('joins every row’s entry id to a username, in one table', () => {
    const view = viewOf(buildSwissStandingsEvent())

    expect(view.rows.map((r) => r.name)).toEqual([
      'player.1',
      'player.2',
      'player.3',
      'player.4',
      'player.5',
    ])
  })

  it('carries every server number and order through untouched', () => {
    // The client shows the figures, it does not compute them (ADR-0788). Feed rows out of
    // rank order and expect them back in that same order, numbers intact — which is what a
    // selector that quietly sorted by rank or by wins would fail.
    const view = viewOf(
      buildSwissStandingsEvent({
        results: buildSwissStandingsResults({
          rows: [
            buildSwissStandingRow({
              entryId: 'entry-3',
              rank: 3,
              gameDifference: -2,
              buchholz: 9,
            }),
            buildSwissStandingRow({
              entryId: 'entry-1',
              rank: 1,
              gameDifference: 7,
              buchholz: 2,
            }),
          ],
        }),
      }),
    )

    expect(view.rows.map((r) => r.entryId)).toEqual(['entry-3', 'entry-1'])
    expect(view.rows.map((r) => r.gameDifference)).toEqual([-2, 7])
    expect(view.rows.map((r) => r.rank)).toEqual([3, 1])
    // **Buchholz rides through with the rest.** It is the SERVER's figure — a sum over
    // *other* rows, which moves when an opponent wins a later match — so a selector that
    // re-derived it from the wins column here would be a second copy that disagrees within
    // a round. The two values are deliberately the reverse of the rank order and equal to
    // nothing else on their rows, so a selector reading the wrong field cannot pass.
    expect(view.rows.map((r) => r.buchholz)).toEqual([9, 2])
  })

  it('joins the champion to a name', () => {
    const view = viewOf(buildSwissStandingsEvent())

    expect(view.complete).toBe(true)
    expect(view.champion).toBe('player.1')
  })

  // A swiss event with rounds still to play — the state it spends most of its life in,
  // since every round is cut up front and paired only as the one before it is decided.
  it('keeps a null champion null while rounds are still unplayed', () => {
    const view = viewOf(
      buildSwissStandingsEvent({
        results: buildSwissStandingsResults({ complete: false, champion: null }),
      }),
    )

    expect(view.complete).toBe(false)
    expect(view.champion).toBeNull()
  })

  it('shows a row naming a no-longer-listed entry as Withdrawn', () => {
    // A player who withdrew after playing: their completed matches still count toward the
    // numbers, but they are no longer an entrant, so the join has no username. It is the
    // withdrawn word, never a blank and never the raw id — the SAME join the group table
    // makes, which is why this selector reuses `nameOf` rather than forking it.
    const view = viewOf(
      buildSwissStandingsEvent({
        entrants: buildEntrants(2), // entry-3, entry-4 and entry-5 are gone
        results: buildSwissStandingsResults({
          rows: [buildSwissStandingRow({ entryId: 'entry-4', rank: 1 })],
        }),
      }),
    )

    expect(view.rows[0].name).toBe(WITHDRAWN_LABEL)
  })
})
