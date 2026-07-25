import {
  buildEightEntrantLiveRounds,
  buildEightEntrantRounds,
  buildFiveEntrantRounds,
  buildTwoEntrantRounds,
} from './bracket.factory'
import { bracketPage as page } from './bracket.page'

describe('Bracket', () => {
  it('lays the rounds out as ordered columns, left-to-right, ending in the Final', async () => {
    page.render({ rounds: buildEightEntrantRounds() })
    await page.findColumn(1)

    // The columns, in DOM order: an eight-entrant bracket reads Quarterfinals → Semifinals
    // → Final, named off the last round rather than a fixed table.
    expect(page.getColumnNames()).toEqual([
      'Quarterfinals fixtures in the bracket',
      'Semifinals fixtures in the bracket',
      'Final fixtures in the bracket',
    ])
  })

  it('names a lone round the Final — a two-entrant bracket is just its final', async () => {
    page.render({ rounds: buildTwoEntrantRounds() })
    await page.findColumn(1)

    expect(page.getColumnNames()).toEqual(['Final fixtures in the bracket'])
    expect(page.getColumnLines(1)).toEqual(['player.1 vs player.2'])
  })

  describe('a cut-but-not-yet-live draw (director review)', () => {
    it('shows the seeded round-1 pairings and their downstream TBD cards', async () => {
      page.render({ rounds: buildEightEntrantRounds() })
      await page.findColumn(1)

      expect(page.getColumnLines(1)).toEqual([
        'player.1 vs player.8',
        'player.5 vs player.4',
        'player.3 vs player.6',
        'player.7 vs player.2',
      ])
      expect(page.getColumnLines(2)).toEqual(['TBD vs TBD', 'TBD vs TBD'])
      expect(page.getColumnLines(3)).toEqual(['TBD vs TBD'])
    })

    it('renders every card inert — nothing has materialized, so no card links to a match', async () => {
      page.render({ rounds: buildEightEntrantRounds() })
      await page.findColumn(1)

      expect(page.queryMatchLink('se8-qf-1')).toBeNull()
      expect(page.getControls('se8-qf-1')).toHaveLength(0)
    })
  })

  describe('a live, in-progress draw', () => {
    it('links a materialized card to its match and shows the match status', async () => {
      page.render({ rounds: buildEightEntrantLiveRounds() })
      await page.findColumn(1)

      expect(page.getMatchLink('se8-qf-1')).toHaveAttribute(
        'href',
        '/matches/m-qf-1',
      )
      expect(page.getMatchStatus('se8-qf-1')).toHaveTextContent('Completed')
    })

    it('seats a round-1 winner into the next column — progression is legible', async () => {
      page.render({ rounds: buildEightEntrantLiveRounds() })
      await page.findColumn(1)

      // player.1 won a quarterfinal and now names a side of a semifinal card, one column on.
      expect(page.getColumnLines(2)[0]).toContain('player.1 vs player.5')
      expect(page.getMatchStatus('se8-sf-1')).toHaveTextContent('In progress')
    })
  })

  describe('byes', () => {
    it('implies a bye as a missing round-1 card, with the byed seed seated one column on', async () => {
      page.render({ rounds: buildFiveEntrantRounds() })
      await page.findColumn(1)

      // Five entrants, padded to eight: the top three seeds draw byes, so round 1 holds a
      // single real quarterfinal — the three byes are the three ABSENT cards.
      expect(page.getColumnLines(1)).toEqual(['player.5 vs player.4'])
      // Byed seeds appear already seated in the semifinals: player.1 opposite a TBD, and an
      // all-bye semifinal that is a fully-known player.3 vs player.2.
      expect(page.getColumnLines(2)).toEqual([
        'player.1 vs TBD',
        'player.3 vs player.2',
      ])
    })

    it('never invents a "bye" card anywhere in the bracket', async () => {
      page.render({ rounds: buildFiveEntrantRounds() })
      await page.findColumn(1)

      const everyCard = [1, 2, 3].flatMap((round) => page.getColumnLines(round))
      expect(everyCard.some((line) => /bye/i.test(line))).toBe(false)
    })
  })
})
