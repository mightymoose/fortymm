import { buildEntrant } from '../../../data/seed.factory'
import { buildGroupDrawView } from './group-draw.factory'
import { groupDrawPage as page } from './group-draw.page'
import { buildDrawRound } from './round-list.factory'
import { buildFixtureLineView } from './round-list/fixture-line.factory'

describe('GroupDraw', () => {
  it('heads the group with its label', () => {
    page.render({ group: buildGroupDrawView({ label: 'Group B' }) })

    expect(page.getGroupHeading('Group B')).toBeInTheDocument()
  })

  it('lists the group’s entrants by NAME, in draw order', () => {
    page.render({
      group: buildGroupDrawView({
        label: 'Group A',
        // Draw order is the view's to decide (`drawState`, data/draw.ts); the group
        // renders exactly what it is handed, in that order.
        entrants: [
          buildEntrant({ id: 'entry-5', userId: 'u-5', username: 'player.5', seed: 1 }),
          buildEntrant({ id: 'entry-1', userId: 'u-1', username: 'player.1' }),
          buildEntrant({ id: 'entry-4', userId: 'u-4', username: 'player.4' }),
        ],
      }),
    })

    expect(page.getGroupEntrants('Group A')).toEqual([
      'player.5',
      'player.1',
      'player.4',
    ])
  })

  it('renders every fixture as a named "A vs B" line, grouped by round', () => {
    page.render({ group: buildGroupDrawView({ id: 'grp-a', label: 'Group A' }) })

    // Wiring plus content: the group's own scope holds all three lines, in round order…
    expect(page.getGroupLines('grp-a')).toEqual([
      'player.1 vs player.4',
      'player.1 vs player.5',
      'player.4 vs player.5',
    ])
    // …and each sits inside the round it belongs to, not merely somewhere on the page.
    expect(page.getRoundLines(2, 'Group A')).toEqual(['player.1 vs player.5'])
  })

  it('names its rounds after itself, so two groups’ rounds never collide', () => {
    page.render({
      group: buildGroupDrawView({
        id: 'grp-b',
        label: 'Group B',
        entrants: [
          buildEntrant({ id: 'entry-2', userId: 'u-2', username: 'player.2' }),
          buildEntrant({ id: 'entry-3', userId: 'u-3', username: 'player.3' }),
        ],
        rounds: [
          buildDrawRound({
            round: 1,
            fixtures: [
              buildFixtureLineView({
                id: 'fx-b-1',
                a: { kind: 'entrant', name: 'player.2' },
                b: { kind: 'entrant', name: 'player.3' },
              }),
            ],
          }),
        ],
      }),
    })

    expect(page.getRoundNames()).toEqual(['Round 1 fixtures in Group B'])
    expect(page.queryRound(1, 'Group A')).toBeNull()
  })

  // A group is a *plan*, not a game in progress: nothing in it is clickable until its
  // fixtures become real matches (#788). It also sits under the event card's stretched
  // open target, where a stray control would compete with it.
  it('is inert — the scaffold carries no controls of its own', () => {
    page.render({ group: buildGroupDrawView({ id: 'grp-a' }) })

    expect(page.getGroupControls('grp-a')).toHaveLength(0)
  })
})
