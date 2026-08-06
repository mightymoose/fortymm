import { buildPoolStandingsView } from './pool-standings-table.factory'
import { poolStandingsTablePage as page } from './pool-standings-table.page'

/**
 * What this component adds to the shared `StandingsTable` is the **pool**: the heading that
 * names it, the accessible name its table carries, the hook that scopes it, and the rows it
 * hands down. That is what this suite asserts, and all it asserts.
 *
 * The table body — the six columns, the server's order rendered untouched, the sign on a
 * game difference, a withdrawn entrant's name — belongs to `StandingsTable` and is pinned
 * once, in `standings-table.test.tsx`. It was asserted here too until the table was
 * extracted, and a string pinned in two files is how a change verified against one of them
 * ships while the other quietly goes stale.
 */
describe('PoolStandingsTable', () => {
  it('names the pool’s section from its heading, and its table after the pool', () => {
    page.render({ pool: buildPoolStandingsView({ name: 'Pool B' }) })

    // The region resolves only while the `<h4>` is still wired to the section around it,
    // which is the half of the naming a bare heading lookup would miss.
    expect(page.getRegion('Pool B')).toBeInTheDocument()
    expect(page.getTable('Pool B')).toBeInTheDocument()
  })

  it('hands the pool’s own rows down to the shared table', () => {
    page.render({ pool: buildPoolStandingsView({ name: 'Pool A' }) })

    expect(page.getRowNames('Pool A')).toEqual(['player.1', 'player.4', 'player.5'])
  })

  // Scoped by POOL ID, because a draw renders several of these side by side: every "in
  // *this* pool" assertion — starting with this one — narrows to that hook. And standings
  // are a READ surface: a table of results has no controls of its own, and it sits under
  // the event card's stretched open target where a stray control would fight it.
  it('scopes the pool by its id, and puts no control inside it', () => {
    page.render({ pool: buildPoolStandingsView({ poolId: 'p-a' }) })

    expect(page.getSection('p-a')).toBeInTheDocument()
    expect(page.getControls('p-a')).toHaveLength(0)
  })
})
