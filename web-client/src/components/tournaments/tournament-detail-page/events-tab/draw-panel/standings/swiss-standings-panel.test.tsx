import {
  buildStandingRow,
  buildSwissStandingsEvent,
  buildSwissStandingsResults,
} from '../../../../data/seed.factory'
import { swissStandingsPanelPage } from './swiss-standings-panel.page'

describe('SwissStandingsPanel', () => {
  /**
   * The claim that separates this panel from the pooled one (the swiss ADR): **one table
   * over the whole field**. A swiss event has no pools, so a panel that grouped — or that
   * forged a pool to reuse `PoolStandingsTable` — would put an id nobody can read into the
   * DOM and name a pool that does not exist.
   */
  it('renders ONE table over the whole field, and no pool at all', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getTableNames()).toEqual([
      'Standings for Swiss Singles',
    ])
    expect(swissStandingsPanelPage.queryPoolTables()).toHaveLength(0)
  })

  it('names the panel’s region from its heading', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getRegion()).toBeInTheDocument()
    expect(swissStandingsPanelPage.getPanel('ev-swiss')).toBeInTheDocument()
  })

  it('lists every entrant in the server’s order, joined to a username', () => {
    swissStandingsPanelPage.render()

    expect(
      swissStandingsPanelPage.getRowNames('Swiss Singles'),
    ).toEqual(['player.1', 'player.2', 'player.3', 'player.4'])
  })

  // The order IS the result (ADR-0788), and swiss is where a client that re-sorted would go
  // wrong most often: the format pairs by score, so level rows are ordinary and the tiebreak
  // that separated them (head-to-head, and Buchholz once it lands) is one the client cannot
  // see. Feed the rows out of rank order and expect them back untouched.
  it('does not re-sort the rows it is handed', () => {
    swissStandingsPanelPage.render({
      event: buildSwissStandingsEvent({
        results: buildSwissStandingsResults({
          rows: [
            buildStandingRow({ entryId: 'entry-3', rank: 3, wins: 1 }),
            buildStandingRow({ entryId: 'entry-1', rank: 1, wins: 3 }),
          ],
        }),
      }),
    })

    expect(swissStandingsPanelPage.getRowNames('Swiss Singles')).toEqual([
      'player.3',
      'player.1',
    ])
    // The rank column follows the rows, so a panel that sorted by rank would show 1 then 3.
    expect(swissStandingsPanelPage.getColumn('Swiss Singles', 0)).toEqual(['3', '1'])
  })

  // The columns are the pool table's, because they ARE the pool table's — one
  // `StandingsTable`, not two that agree today. `+7` and `-7` are different standings, so
  // the sign is asserted, not just the digit.
  it('shows the server’s wins, losses, game difference and games won', () => {
    swissStandingsPanelPage.render()

    expect(swissStandingsPanelPage.getColumn('Swiss Singles', 2)).toEqual([
      '3',
      '2',
      '1',
      '0',
    ])
    expect(swissStandingsPanelPage.getColumn('Swiss Singles', 4)).toEqual([
      '+7',
      '+2',
      '-2',
      '-7',
    ])
    expect(swissStandingsPanelPage.getColumn('Swiss Singles', 5)).toEqual([
      '9',
      '7',
      '5',
      '2',
    ])
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
    expect(swissStandingsPanelPage.getRowNames('Swiss Singles')).toHaveLength(4)
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
