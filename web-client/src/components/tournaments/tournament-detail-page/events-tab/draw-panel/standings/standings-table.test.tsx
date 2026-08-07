import { screen, within } from '@/test/utilities'

import {
  buildStandingLine,
  buildSwissStandingLine,
} from './standings-table.factory'
import { standingsTablePage } from './standings-table.page'

const POOL = 'Standings for Pool A'
const SWISS = 'Standings for Swiss Singles'

describe('StandingsTable', () => {
  it('takes its accessible name from the caller', () => {
    // The one thing that varies between a pool's table and a swiss event's, so it is a prop
    // rather than something derived here — and asserted with a name neither caller uses.
    standingsTablePage.renderPool({ ariaLabel: 'Standings for the whole field' })

    expect(
      standingsTablePage.getTable('Standings for the whole field'),
    ).toBeInTheDocument()
  })

  it('heads the columns with rank, player and the four figures', () => {
    standingsTablePage.renderPool()

    // The glyphs a sighted reader sees. The `sr-only` full words ride in the same node, so
    // the trimmed text carries both — which is the point: neither channel is left to infer.
    expect(standingsTablePage.getHeaderGlyphs(POOL)).toEqual([
      '#Rank',
      'Player',
      'WWins',
      'LLosses',
      'DiffGame difference',
      'GWGames won',
    ])
  })

  /**
   * The same six headers again, read the OTHER way: by the **accessible name**, which is the
   * full word a screen reader hears. It is a different claim from the glyphs above, and only
   * this one can make it — `getHeaderGlyphs` reads `textContent`, which concatenates both
   * spans and ignores `aria-hidden` entirely, so it stays green on a header that reads out
   * as "W Wins".
   *
   * `getByRole` here is the whole proof that the two channels are wired right: it would not
   * find a header whose only text was the bare glyph, and it would not find `Wins` if the
   * glyph span had lost its `aria-hidden`.
   */
  it('says each column’s FULL WORD to a screen reader, and only that word', () => {
    standingsTablePage.renderPool()

    for (const name of [
      'Rank',
      'Player',
      'Wins',
      'Losses',
      'Game difference',
      'Games won',
    ]) {
      expect(
        standingsTablePage.getColumnHeader('Standings for Pool A', name),
      ).toBeInTheDocument()
    }
  })

  it('renders the rows in the order it is handed, with the server’s figures', () => {
    standingsTablePage.renderPool()

    expect(standingsTablePage.getColumnUnder(POOL, 'Rank')).toEqual(['1', '2', '3'])
    expect(standingsTablePage.getColumnUnder(POOL, 'Player')).toEqual([
      'player.1',
      'player.4',
      'player.5',
    ])
    expect(standingsTablePage.getColumnUnder(POOL, 'Wins')).toEqual(['2', '1', '0'])
    expect(standingsTablePage.getColumnUnder(POOL, 'Losses')).toEqual(['0', '1', '2'])
    expect(standingsTablePage.getColumnUnder(POOL, 'Games won')).toEqual([
      '4',
      '3',
      '1',
    ])
  })

  /** The sign is load-bearing: `+2` and `-2` are different standings, and a bare `2` would
   * read as both. Zero carries no sign — a `+0` would claim a margin nobody has. */
  it('signs a positive game difference, leaves a negative one, and bares a zero', () => {
    standingsTablePage.renderPool()

    expect(standingsTablePage.getColumnUnder(POOL, 'Game difference')).toEqual([
      '+3',
      '0',
      '-3',
    ])
  })

  it('does not re-sort or recompute what it is given', () => {
    // Rows out of rank order, and a game difference that does NOT equal `gamesWon -
    // gamesLost`: the server's figure is shown, never re-derived from the two counts beside
    // it (which would be a second copy that could disagree).
    standingsTablePage.renderPool({
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

    expect(standingsTablePage.getColumnUnder(POOL, 'Rank')).toEqual(['4', '1'])
    expect(standingsTablePage.getColumnUnder(POOL, 'Game difference')).toEqual([
      '+5',
      '+3',
    ])
  })

  it('keys each row on its entry id, so a row can be addressed', () => {
    standingsTablePage.renderPool()

    expect(
      within(standingsTablePage.getRow('entry-5')).getAllByRole('cell')[1],
    ).toHaveTextContent('player.5')
    expect(standingsTablePage.queryRow('entry-nobody')).toBeNull()
  })

  it('renders a header and no body rows for an empty table', () => {
    // The designed state of a cut-but-unplayed event, not an error: the columns still say
    // what is coming.
    standingsTablePage.renderPool({ rows: [] })

    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(1)
  })

  /**
   * **The Buchholz column** (ADR "swiss standings add Buchholz, and head-to-head is guarded
   * on having met") — the sum of an entrant's opponents' win counts, and the step of the
   * tiebreak chain the other columns cannot show.
   *
   * It belongs to the `swiss` arm and to nothing else, which is why `format` is a tag on the
   * props rather than a flag beside them: a pool gives every entrant the same opposition, so
   * strength of schedule carries no information there.
   */
  describe('the Buchholz column', () => {
    it('shows it for a swiss table, headed and spoken in full', () => {
      standingsTablePage.renderSwiss()

      expect(standingsTablePage.getHeaderGlyphs(SWISS)).toEqual([
        '#Rank',
        'Player',
        'WWins',
        'LLosses',
        // Between losses and game difference, mirroring the chain that ordered the table:
        // wins → head-to-head → **Buchholz** → game difference → games won.
        'BucBuchholz',
        'DiffGame difference',
        'GWGames won',
      ])
    })

    /** ⚠️ The assertion that makes this a test of the *figure* rather than of a column's
     * existence. The three values are 8, 6, 7 — not descending with the rank, and equal to
     * nothing in the columns beside them (wins 2/1/0, difference +3/0/−3, games won 4/3/1)
     * — so a cell wired to the wrong field, or to a constant, cannot come out right. */
    it('shows each row’s own Buchholz figure, not a neighbouring column’s', () => {
      standingsTablePage.renderSwiss()

      expect(standingsTablePage.getColumnUnder(SWISS, 'Buchholz')).toEqual([
        '8',
        '6',
        '7',
      ])
    })

    it('shows zero as zero — every opponent yet to win is a real standing', () => {
      // Not blank, and not an em-dash: `0` is the ordinary state of round 1, and a cell that
      // treated it as missing would be inventing an absence.
      standingsTablePage.renderSwiss({
        rows: [
          buildSwissStandingLine({
            entryId: 'entry-1',
            name: 'player.1',
            buchholz: 0,
          }),
        ],
      })

      expect(standingsTablePage.getColumnUnder(SWISS, 'Buchholz')).toEqual(['0'])
    })

    /** Buchholz is a sum of win counts, so it is never negative — and it is not a margin, so
     * a `+` would suggest something it does not mean. The neighbouring game-difference cell
     * DOES sign, in the same row, which is what makes this a real distinction rather than an
     * untested coincidence. */
    it('does not sign it, while the game difference beside it still does', () => {
      standingsTablePage.renderSwiss({
        rows: [
          buildSwissStandingLine({
            entryId: 'entry-1',
            name: 'player.1',
            buchholz: 7,
            gameDifference: 7,
          }),
        ],
      })

      expect(standingsTablePage.getColumnUnder(SWISS, 'Buchholz')).toEqual(['7'])
      expect(standingsTablePage.getColumnUnder(SWISS, 'Game difference')).toEqual([
        '+7',
      ])
    })

    /** The other half of what `format` decides. A pool table must not grow the column —
     * strength of schedule is meaningless where everyone faces the same field — and this is
     * the assertion that fails if the header were made unconditional. */
    it('is ABSENT from a pool table', () => {
      standingsTablePage.renderPool()

      expect(standingsTablePage.hasColumn(POOL, 'Buchholz')).toBe(false)
    })

    /** Header and cells are read off the same tag, so they cannot disagree — but "cannot" is
     * worth a measurement, because a mismatch shifts every column after it and would make a
     * by-index assertion read the wrong neighbour rather than fail outright. */
    it('gives every row exactly as many cells as the header has columns', () => {
      standingsTablePage.renderSwiss()
      expect(standingsTablePage.getCellCounts(SWISS)).toEqual([7, 7, 7])
    })

    it('gives a pool row one cell fewer', () => {
      standingsTablePage.renderPool()
      expect(standingsTablePage.getCellCounts(POOL)).toEqual([6, 6, 6])
    })
  })
})
