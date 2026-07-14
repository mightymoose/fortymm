import {
  buildPoolStandingsView,
  buildStandingLine,
} from './pool-standings-table.factory'
import { poolStandingsTablePage as page } from './pool-standings-table.page'

describe('PoolStandingsTable', () => {
  it('heads the table with its pool name', () => {
    page.render({ pool: buildPoolStandingsView({ name: 'Pool B' }) })

    expect(page.getTable('Pool B')).toBeInTheDocument()
  })

  it('has a column for wins, losses, game difference and games won — named for a screen reader', () => {
    page.render({ pool: buildPoolStandingsView({ name: 'Pool A' }) })

    // Each header is found by its ACCESSIBLE name — the full word a reader hears, not the
    // terse `W`/`L`/`Diff`/`GW` glyph on screen. A header that shipped only the glyph would
    // fail these lookups, which is the whole point of asserting the accessible name.
    for (const name of [
      'Rank',
      'Player',
      'Wins',
      'Losses',
      'Game difference',
      'Games won',
    ]) {
      expect(page.getColumnHeader('Pool A', name)).toBeInTheDocument()
    }
  })

  it('renders every entrant by NAME, one row per row', () => {
    page.render({ pool: buildPoolStandingsView({ name: 'Pool A' }) })

    expect(page.getRowNames('Pool A')).toEqual(['player.1', 'player.4', 'player.5'])
  })

  it('renders rows in the SERVER’s order — it does not re-sort them', () => {
    // A pool handed out of finishing order: the 0–2 player first, the 2–0 leader last.
    // The table must render exactly this order — the order IS the result (ADR-0788), and a
    // client that re-sorted by wins would silently disagree with a head-to-head tiebreak it
    // cannot see. So the assertion is: input order out, unchanged.
    page.render({
      pool: buildPoolStandingsView({
        name: 'Pool A',
        rows: [
          buildStandingLine({ entryId: 'entry-5', name: 'player.5', rank: 3, wins: 0 }),
          buildStandingLine({ entryId: 'entry-1', name: 'player.1', rank: 1, wins: 2 }),
          buildStandingLine({ entryId: 'entry-4', name: 'player.4', rank: 2, wins: 1 }),
        ],
      }),
    })

    expect(page.getRowNames('Pool A')).toEqual(['player.5', 'player.1', 'player.4'])
  })

  it('shows each row’s numbers, with the SIGN on the game difference', () => {
    page.render({ pool: buildPoolStandingsView() })

    // rank, player, wins, losses, game difference (signed), games won.
    expect(page.getRowCells('entry-1')).toEqual(['1', 'player.1', '2', '0', '+3', '4'])
    // A zero difference is bare — neither `+0` nor `-0`.
    expect(page.getRowCells('entry-4')).toEqual(['2', 'player.4', '1', '1', '0', '3'])
    // A negative difference keeps its minus — `-3` and `+3` are different standings, and a
    // bare `3` would read as both.
    expect(page.getRowCells('entry-5')).toEqual(['3', 'player.5', '0', '2', '-3', '1'])
  })

  it('shows a WITHDRAWN entrant’s name where the join could not resolve one', () => {
    // A row can name an entry the event no longer lists — someone who withdrew after
    // playing. The view-model joins that to `Withdrawn`; the table renders it as any other
    // name, never a raw id or a blank.
    page.render({
      pool: buildPoolStandingsView({
        rows: [buildStandingLine({ entryId: 'entry-gone', name: 'Withdrawn' })],
      }),
    })

    expect(page.getRowCells('entry-gone')[1]).toBe('Withdrawn')
  })

  // Standings are a READ surface: a table of results has no controls of its own, and it
  // sits under the event card's stretched open target where a stray control would fight it.
  it('is inert — the table carries no controls', () => {
    page.render({ pool: buildPoolStandingsView({ poolId: 'p-a' }) })

    expect(page.getControls('p-a')).toHaveLength(0)
  })
})
