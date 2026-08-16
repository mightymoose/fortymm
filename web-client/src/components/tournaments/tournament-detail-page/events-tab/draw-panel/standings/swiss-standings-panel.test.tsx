import {
  buildSwissStandingRow,
  buildSwissStandingsEvent,
  buildSwissStandingsResults,
} from '../../../../data/seed.factory'
import { swissStandingsPanelPage } from './swiss-standings-panel.page'

describe('SwissStandingsPanel', () => {
  /**
   * The claim that separates this panel from the grouped one (the swiss ADR): **one table
   * over the whole field**. A swiss event has no groups, so a panel that grouped — or that
   * forged a group to reuse `GroupStandingsTable` — would put an id nobody can read into the
   * DOM and name a group that does not exist.
   */
  it('renders ONE table over the whole field, and no group at all', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getTableNames()).toEqual([
      'Standings for Swiss Singles',
    ])
    expect(swissStandingsPanelPage.queryGroupTables()).toHaveLength(0)
  })

  it('names the panel’s region from its heading', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getRegion()).toBeInTheDocument()
    expect(swissStandingsPanelPage.getPanel('ev-swiss')).toBeInTheDocument()
  })

  it('lists every entrant in the server’s order, joined to a username', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getRowNames('Swiss Singles')).toEqual([
      'player.1',
      'player.2',
      'player.3',
      'player.4',
      'player.5',
    ])
  })

  // The order IS the result (ADR-0788), and swiss is where a client that re-sorted would go
  // wrong most often: the format pairs by score, so level rows are ordinary and the tiebreaks
  // that separated them (head-to-head, and Buchholz) are ones the client must not second-
  // guess. Feed the rows out of rank order and expect them back untouched.
  it('does not re-sort the rows it is handed', () => {
    swissStandingsPanelPage.render({
      event: buildSwissStandingsEvent({
        results: buildSwissStandingsResults({
          rows: [
            buildSwissStandingRow({ entryId: 'entry-3', rank: 3, wins: 1 }),
            buildSwissStandingRow({ entryId: 'entry-1', rank: 1, wins: 3 }),
          ],
        }),
      }),
    })

    expect(swissStandingsPanelPage.getRowNames('Swiss Singles')).toEqual([
      'player.3',
      'player.1',
    ])
    // The rank column follows the rows, so a panel that sorted by rank would show 1 then 3.
    expect(swissStandingsPanelPage.getColumnUnder('Swiss Singles', 'Rank')).toEqual([
      '3',
      '1',
    ])
  })

  // The columns are the group table's, because they ARE the group table's — one
  // `StandingsTable`, not two that agree today. `+6` and `-4` are different standings, so the
  // sign is asserted, not just the digit.
  it('shows the server’s wins, losses, game difference and games won', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getColumnUnder('Swiss Singles', 'Wins')).toEqual([
      '3',
      '2',
      '2',
      '1',
      '1',
    ])
    expect(
      swissStandingsPanelPage.getColumnUnder('Swiss Singles', 'Game difference'),
    ).toEqual(['+6', '0', '+1', '-3', '-4'])
    expect(
      swissStandingsPanelPage.getColumnUnder('Swiss Singles', 'Games won'),
    ).toEqual(['9', '6', '4', '3', '2'])
  })

  /**
   * **The Buchholz column** (ADR "swiss standings add Buchholz, and head-to-head is guarded
   * on having met") — the number that decided the order, on the one surface where a director
   * can see the order it decided.
   */
  describe('the Buchholz column', () => {
    it('shows each entrant’s own figure', () => {
      swissStandingsPanelPage.render()

      expect(
        swissStandingsPanelPage.getColumnUnder('Swiss Singles', 'Buchholz'),
      ).toEqual(['5', '5', '4', '5', '4'])
    })

    /**
     * ⚠️ **The row that makes the column worth having.** `player.2` and `player.3` are level
     * on wins, never met, and sit in that order because of Buchholz — 5 against 4 — *against*
     * their game difference, which is 0 and +1. Read on margin alone they are the wrong way
     * round.
     *
     * So this asserts the three numbers together, in one place: without the Buchholz column
     * the table shows a director an order it has no way of explaining, which is the whole
     * reason the figure is on the wire (`SwissStandingRowRead`).
     */
    it('explains an order that game difference alone contradicts', () => {
      swissStandingsPanelPage.render()

      const names = swissStandingsPanelPage.getRowNames('Swiss Singles')
      const wins = swissStandingsPanelPage.getColumnUnder('Swiss Singles', 'Wins')
      const buchholz = swissStandingsPanelPage.getColumnUnder(
        'Swiss Singles',
        'Buchholz',
      )
      const diff = swissStandingsPanelPage.getColumnUnder(
        'Swiss Singles',
        'Game difference',
      )

      const above = names.indexOf('player.2')
      const below = names.indexOf('player.3')
      expect(above).toBeLessThan(below)
      // Level on wins…
      expect(wins[above]).toBe(wins[below])
      // …the one above has the WORSE game difference…
      expect(diff[above]).toBe('0')
      expect(diff[below]).toBe('+1')
      // …and the better Buchholz, which is what put it there.
      expect(buchholz[above]).toBe('5')
      expect(buchholz[below]).toBe('4')
    })
  })

  it('crowns the champion once every round is decided', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.queryChampion('ev-swiss')).toHaveTextContent(
      'player.1',
    )
  })

  // The state a swiss event spends most of its life in: every round cut up front, and the
  // later ones not yet paired. The table is already worth reading; nobody has won yet.
  it('shows the table but crowns nobody while rounds are still unplayed', () => {
    swissStandingsPanelPage.render({
      event: buildSwissStandingsEvent({
        results: buildSwissStandingsResults({ complete: false, champion: null }),
      }),
    })

    expect(swissStandingsPanelPage.queryChampion('ev-swiss')).toBeNull()
    expect(swissStandingsPanelPage.getRowNames('Swiss Singles')).toHaveLength(5)
  })

  // `complete` alone is not the condition, and neither is `champion` alone. A complete
  // event whose champion the server has not named must not be crowned by the client reading
  // the top row — which is exactly what a panel that dropped the null check would do.
  it('crowns nobody when the server named no champion, complete or not', () => {
    swissStandingsPanelPage.render({
      event: buildSwissStandingsEvent({
        results: buildSwissStandingsResults({ complete: true, champion: null }),
      }),
    })

    expect(swissStandingsPanelPage.queryChampion('ev-swiss')).toBeNull()
  })
})
