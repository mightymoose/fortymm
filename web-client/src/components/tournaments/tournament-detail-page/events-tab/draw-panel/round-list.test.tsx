import { buildDrawRound, buildDrawRounds } from './round-list.factory'
import { roundListPage as page } from './round-list.page'
import { buildFixtureLineView } from './round-list/fixture-line.factory'

describe('RoundList', () => {
  it('groups the fixtures by round, in round order', () => {
    page.render({ rounds: buildDrawRounds(), groupName: 'Group A' })

    expect(page.getRoundNames()).toEqual([
      'Round 1 fixtures in Group A',
      'Round 2 fixtures in Group A',
      'Round 3 fixtures in Group A',
    ])
  })

  it('puts each round’s named fixtures inside that round, and nowhere else', () => {
    page.render({ rounds: buildDrawRounds(), groupName: 'Group A' })

    expect(page.getRoundLines(1, 'Group A')).toEqual(['player.1 vs player.4'])
    expect(page.getRoundLines(2, 'Group A')).toEqual(['player.1 vs player.5'])
    expect(page.getRoundLines(3, 'Group A')).toEqual(['player.4 vs player.5'])
  })

  it('renders a round’s fixtures in the order the view gives them', () => {
    page.render({
      rounds: [
        buildDrawRound({
          round: 4,
          fixtures: [
            buildFixtureLineView({
              id: 'fx-1',
              position: 1,
              a: { kind: 'entrant', name: 'player.1' },
              b: { kind: 'entrant', name: 'player.2' },
            }),
            buildFixtureLineView({
              id: 'fx-2',
              position: 2,
              a: { kind: 'entrant', name: 'player.3' },
              b: { kind: 'entrant', name: 'player.4' },
            }),
          ],
        }),
      ],
      groupName: 'Group B',
    })

    expect(page.getRoundLines(4, 'Group B')).toEqual([
      'player.1 vs player.2',
      'player.3 vs player.4',
    ])
  })

  // The ODD group. Three players play three rounds of ONE fixture, because one of them
  // sits each round out — and a bye is exactly that absence (ADR-0786). A "bye" row, or
  // a fixture with an empty side, would be an invention.
  it('leaves a bye as the absence of a fixture — never a row of its own', () => {
    page.render({ rounds: buildDrawRounds(), groupName: 'Group A' })

    expect(page.getLineTexts()).toEqual([
      'player.1 vs player.4',
      'player.1 vs player.5',
      'player.4 vs player.5',
    ])
    expect(page.getLineTexts().some((line) => /bye/i.test(line))).toBe(false)
  })

  it('names each round’s list per GROUP, so two groups’ round 1s are told apart', () => {
    page.render({ rounds: [buildDrawRound({ round: 1 })], groupName: 'Group B' })

    expect(page.queryRound(1, 'Group B')).toBeInTheDocument()
    expect(page.queryRound(1, 'Group A')).toBeNull()
  })
})
