import {
  buildMidFlightTwoStageResults,
  buildTwoStageEvent,
  buildTwoStageResults,
  groupIdFor,
  twoStageResultsOf,
} from './seed.factory'
import { eventStandingsThenFinishes } from './two-stage'
import type { TournamentEvent } from './types'

/** The view for an event's own two-stage block — the pairing `ResultsPanel` makes at
 * runtime, since the selector is handed the block rather than finding one. */
const viewOf = (event: TournamentEvent) =>
  eventStandingsThenFinishes(event, twoStageResultsOf(event))

describe('eventStandingsThenFinishes', () => {
  it('crowns the BRACKET’s winner, who tops no group', () => {
    // The claim the whole format turns on (ADR 20260727): the group stage only seeds the
    // bracket, so the champion is the final's winner and never a standings leader. In this
    // fixture `entry-2` wins the final while `entry-5` and `entry-3` lead the two groups —
    // a champion read off the standings would name one of THEM.
    const view = viewOf(buildTwoStageEvent())

    expect(view.champion).toBe('player.2')
    expect(view.complete).toBe(true)
    // …and it is not the top of either group table, stated explicitly so the assertion
    // above cannot be satisfied by coincidence.
    expect(view.standings.groups.map((g) => g.rows[0].name)).toEqual([
      'player.5',
      'player.3',
    ])
  })

  it('leaves neither stage holding a champion of its own — one banner, not three', () => {
    // The event's champion is a fact about the EVENT, shown once above both stages. A
    // sub-view that kept one would print the same name twice on one card.
    const view = viewOf(buildTwoStageEvent())

    expect(view.standings.champion).toBeNull()
    expect(view.finishes.champion).toBeNull()
  })

  it('shapes the group stage exactly as a round-robin’s standings — labelled by position, in order', () => {
    const view = viewOf(buildTwoStageEvent())

    expect(view.standings.groups.map((g) => g.label)).toEqual(['Group A', 'Group B'])
    expect(view.standings.groups[0].rows.map((r) => r.name)).toEqual([
      'player.5',
      'player.1',
      'player.4',
      'player.8',
    ])
    // The numbers are the server's, carried through untouched.
    expect(view.standings.groups[0].rows[0]).toMatchObject({
      rank: 1,
      wins: 3,
      losses: 0,
      gameDifference: 5,
    })
  })

  it('shapes the knockout stage exactly as a single-elimination’s finishes — ties and all', () => {
    const view = viewOf(buildTwoStageEvent())

    expect(view.finishes.finishes.map((f) => [f.positionLabel, f.name])).toEqual([
      ['1st', 'player.2'],
      ['2nd', 'player.1'],
      // The two beaten semifinalists — the group winners — tie 3rd, because the bracket
      // never played them off.
      ['T3', 'player.5'],
      ['T3', 'player.3'],
    ])
  })

  it('renders the MID-FLIGHT event honestly: complete groups, partial finishes, no champion', () => {
    // Groups decided, the final seated and unplayed. `complete` is BOTH stages, so it is
    // false; there is no champion yet; and the finishes list starts at position 3 — 1st and
    // 2nd do not exist. The group tables are unaffected and still complete.
    const view = viewOf(
      buildTwoStageEvent({ results: buildMidFlightTwoStageResults() }),
    )

    expect(view.complete).toBe(false)
    expect(view.champion).toBeNull()
    expect(view.standings.groups.every((g) => g.complete)).toBe(true)
    // …and each stage answers for ITSELF, which is the whole point of this state: the
    // group stage IS complete while the event is not, and the bracket is not. A sub-view
    // handed the event's flag would call the decided group stage undecided.
    expect(view.standings.complete).toBe(true)
    expect(view.finishes.complete).toBe(false)
    expect(view.finishes.finishes.map((f) => [f.positionLabel, f.name])).toEqual([
      ['T3', 'player.5'],
      ['T3', 'player.3'],
    ])
    // Nobody is flagged champion in the placement list either — position 1 is unclaimed.
    expect(view.finishes.finishes.some((f) => f.isChampion)).toBe(false)
  })

  it('carries the server’s order through — it sorts neither stage', () => {
    // The order IS the result in both stages (ADR-0788, ADR-0785). Feed each one out of
    // order and expect it back exactly as sent.
    const decided = buildTwoStageResults()
    const view = viewOf(
      buildTwoStageEvent({
        results: buildTwoStageResults({
          groups: [decided.groups[1], decided.groups[0]],
          finishes: [...decided.finishes].reverse(),
        }),
      }),
    )

    expect(view.standings.groups.map((g) => g.groupId)).toEqual([
      groupIdFor('res-b'),
      groupIdFor('res-a'),
    ])
    expect(view.finishes.finishes.map((f) => f.entryId)).toEqual([
      'entry-3',
      'entry-5',
      'entry-1',
      'entry-2',
    ])
  })
})
