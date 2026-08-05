import { screen, within } from '@/test/utilities'

import { buildStandingLine } from './standings-table.factory'
import { standingsTablePage } from './standings-table.page'

describe('StandingsTable', () => {
  it('takes its accessible name from the caller', () => {
    // The one thing that varies between a pool's table and a swiss event's, so it is a prop
    // rather than something derived here — and asserted with a name neither caller uses.
    standingsTablePage.render({ ariaLabel: 'Standings for the whole field' })

    expect(
      standingsTablePage.getTable('Standings for the whole field'),
    ).toBeInTheDocument()
  })

  it('heads the columns with rank, player and the four figures', () => {
    standingsTablePage.render()

    // The glyphs a sighted reader sees. The `sr-only` full words ride in the same node, so
    // the trimmed text carries both — which is the point: neither channel is left to infer.
    expect(standingsTablePage.getHeaderGlyphs('Standings for Pool A')).toEqual([
      '#Rank',
      'Player',
      'WWins',
      'LLosses',
      'DiffGame difference',
      'GWGames won',
    ])
  })

  it('renders the rows in the order it is handed, with the server’s figures', () => {
    standingsTablePage.render()

    expect(standingsTablePage.getColumn('Standings for Pool A', 0)).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(standingsTablePage.getColumn('Standings for Pool A', 1)).toEqual([
      'player.1',
      'player.4',
      'player.5',
    ])
    expect(standingsTablePage.getColumn('Standings for Pool A', 2)).toEqual([
      '2',
      '1',
      '0',
    ])
    expect(standingsTablePage.getColumn('Standings for Pool A', 3)).toEqual([
      '0',
      '1',
      '2',
    ])
    expect(standingsTablePage.getColumn('Standings for Pool A', 5)).toEqual([
      '4',
      '3',
      '1',
    ])
  })

  /** The sign is load-bearing: `+2` and `-2` are different standings, and a bare `2` would
   * read as both. Zero carries no sign — a `+0` would claim a margin nobody has. */
  it('signs a positive game difference, leaves a negative one, and bares a zero', () => {
    standingsTablePage.render()

    expect(standingsTablePage.getColumn('Standings for Pool A', 4)).toEqual([
      '+3',
      '0',
      '-3',
    ])
  })

  it('does not re-sort or recompute what it is given', () => {
    // Rows out of rank order, and a game difference that does NOT equal `gamesWon -
    // gamesLost`: the server's figure is shown, never re-derived from the two counts beside
    // it (which would be a second copy that could disagree).
    standingsTablePage.render({
      rows: [
        buildStandingLine({
          entryId: 'entry-9',
          name: 'player.9',
          rank: 4,
          gamesWon: 1,
          gamesLost: 1,
          gameDifference: 5,
        }),
        buildStandingLine({ entryId: 'entry-1', name: 'player.1', rank: 1 }),
      ],
    })

    expect(standingsTablePage.getColumn('Standings for Pool A', 0)).toEqual(['4', '1'])
    expect(standingsTablePage.getColumn('Standings for Pool A', 4)).toEqual(['+5', '+3'])
  })

  it('keys each row on its entry id, so a row can be addressed', () => {
    standingsTablePage.render()

    expect(
      within(standingsTablePage.getRow('entry-5')).getAllByRole('cell')[1],
    ).toHaveTextContent('player.5')
    expect(standingsTablePage.queryRow('entry-nobody')).toBeNull()
  })

  it('renders a header and no body rows for an empty table', () => {
    // The designed state of a cut-but-unplayed event, not an error: the columns still say
    // what is coming.
    standingsTablePage.render({ rows: [] })

    expect(
      within(screen.getByRole('table')).getAllByRole('row'),
    ).toHaveLength(1)
  })
})
