import {
  buildEmptyRecentMatchesView,
  buildRecentMatchesView,
} from './recent-matches-display.factory'
import {
  buildEmptyRecentMatchDeltaView,
  buildLiveRecentMatchRowView,
  buildRecentMatchOpponentView,
  buildRecentMatchRowView,
  buildRecentMatchStatusView,
  buildSoloRecentMatchRowView,
} from './recent-matches-display/recent-match-row.factory'
import { recentMatchesDisplayPage } from './recent-matches-display.page'

/** The six the bundle carries — deliberately mixed, because the list is
 * all-inclusive: a live match, an awaiting one, a solo one and a voided one sit
 * alongside the decided ones. */
const sixMixedRows = () => [
  buildLiveRecentMatchRowView({
    id: 'm-live',
    opponent: buildRecentMatchOpponentView({ id: 'p-8', name: 'kai.zhou' }),
  }),
  buildRecentMatchRowView({
    id: 'm-awaiting',
    opponent: buildRecentMatchOpponentView({ id: 'p-11', name: 'lin.wu' }),
    status: buildRecentMatchStatusView({
      tone: 'awaiting',
      label: 'Awaiting acceptance',
    }),
    score: { kind: 'text', text: 'Awaiting' },
    delta: buildEmptyRecentMatchDeltaView({ ariaLabel: 'Not yet decided' }),
  }),
  buildRecentMatchRowView({
    id: 'm-win',
    opponent: buildRecentMatchOpponentView({ id: 'p-9', name: 'ada.lovelace' }),
  }),
  buildRecentMatchRowView({
    id: 'm-voided',
    opponent: buildRecentMatchOpponentView({ id: 'p-12', name: 'joe.bell' }),
    status: buildRecentMatchStatusView({ tone: 'voided', label: 'Voided' }),
    score: { kind: 'text', text: '—' },
    delta: buildEmptyRecentMatchDeltaView(),
  }),
  buildSoloRecentMatchRowView({ id: 'm-solo' }),
  buildRecentMatchRowView({
    id: 'm-unrated',
    opponent: buildRecentMatchOpponentView({ id: 'p-13', name: 'nia.k' }),
    delta: buildEmptyRecentMatchDeltaView(),
  }),
]

describe('RecentMatchesDisplay', () => {
  it('shows the six matches the bundle carries — the live one included', async () => {
    // Nothing is filtered: a match in play is not a win and not a loss, and the
    // card would be lying if it dropped it.
    recentMatchesDisplayPage.render({
      recent: buildRecentMatchesView({ rows: sixMixedRows() }),
    })

    await recentMatchesDisplayPage.findCard()

    expect(recentMatchesDisplayPage.getRows()).toHaveLength(6)
    expect(recentMatchesDisplayPage.getRow('kai.zhou')).toBeInTheDocument()
    expect(recentMatchesDisplayPage.getRow('No opponent')).toBeInTheDocument()
  })

  it('has no result-chip column — the grid is Opponent, Score, Δ, When', async () => {
    recentMatchesDisplayPage.render()

    await recentMatchesDisplayPage.findCard()

    // The Δ header shows the glyph and reads out as "Rating change".
    expect(recentMatchesDisplayPage.getColumnHeaders()).toEqual([
      'Opponent',
      'Score',
      'ΔRating change',
      'When',
    ])
  })

  it('carries an unfinished match’s state on its dot and in its score cell', async () => {
    recentMatchesDisplayPage.render({
      recent: buildRecentMatchesView({ rows: sixMixedRows() }),
    })

    await recentMatchesDisplayPage.findCard()

    expect(
      recentMatchesDisplayPage.getStatusDot('kai.zhou'),
    ).toHaveAccessibleName('Live')
    expect(recentMatchesDisplayPage.getScoreCell('kai.zhou')).toHaveTextContent(
      'Live',
    )
    expect(recentMatchesDisplayPage.getStatusDot('lin.wu')).toHaveAccessibleName(
      'Awaiting acceptance',
    )
    expect(recentMatchesDisplayPage.getScoreCell('lin.wu')).toHaveTextContent(
      'Awaiting',
    )
  })

  it('shows an em dash — never "+0" — for an undecided or unrated row', async () => {
    recentMatchesDisplayPage.render({
      recent: buildRecentMatchesView({ rows: sixMixedRows() }),
    })

    await recentMatchesDisplayPage.findCard()

    // Undecided: the live match hasn't moved anything yet.
    expect(recentMatchesDisplayPage.getDeltaCell('kai.zhou')).toHaveTextContent(
      '—',
    )
    // Decided, but unrated — a win that moved no rating. Same em dash.
    expect(recentMatchesDisplayPage.getDeltaCell('nia.k')).toHaveTextContent(
      '—',
    )
    expect(
      recentMatchesDisplayPage.getDeltaCell('nia.k'),
    ).not.toHaveTextContent('0')
    // …while a rated, decided match reports the move it made.
    expect(
      recentMatchesDisplayPage.getDeltaCell('ada.lovelace'),
    ).toHaveTextContent('+12')
  })

  it('links every named opponent to their profile — and the solo row to no PLAYER', async () => {
    // The card's rows are the page's most obvious next step: the people you have
    // been playing. They were plain text. Every *named* one is now a link — and
    // the solo row, which names nobody, is deliberately not: its opponent id is
    // null on the wire, and a link built from it would read `/players/null`.
    recentMatchesDisplayPage.render({
      recent: buildRecentMatchesView({ rows: sixMixedRows() }),
    })

    await recentMatchesDisplayPage.findCard()

    expect(recentMatchesDisplayPage.getOpponentHref('kai.zhou')).toBe(
      '/players/p-8',
    )
    expect(recentMatchesDisplayPage.getOpponentHref('ada.lovelace')).toBe(
      '/players/p-9',
    )
    // A voided match still happened, against a real person: the row is not a
    // link because of its *result*, it is a link because it has an opponent.
    expect(recentMatchesDisplayPage.getOpponentHref('joe.bell')).toBe(
      '/players/p-12',
    )

    // The solo row's Opponent cell is plain text — but the ROW is still a link,
    // to its match (#989), so the claim is not "no anchors in this row". It is
    // that nothing in the row points at a *player*: the thing a naive
    // nullable-id fix gets wrong.
    expect(
      recentMatchesDisplayPage.queryOpponentLink('No opponent'),
    ).toBeNull()
    expect(
      recentMatchesDisplayPage.getRow('No opponent').innerHTML,
    ).not.toContain('/players/')
    expect(recentMatchesDisplayPage.getRowLinks('No opponent')).toHaveLength(1)
  })

  it('links to the full history, naming the all-inclusive total', async () => {
    // 50 matches, of which 35 are decided — the link names 50 (ADR-0915: the two
    // totals differ on purpose).
    recentMatchesDisplayPage.render({
      recent: buildRecentMatchesView({
        playerId: 'p-7',
        total: 50,
        viewAllLabel: 'View all 50 matches',
      }),
    })

    await recentMatchesDisplayPage.findCard()

    const link = recentMatchesDisplayPage.getViewAllLink()
    expect(link).toHaveAccessibleName('View all 50 matches')
    expect(link).toHaveAttribute('href', '/players/p-7/matches')
  })

  it('keeps the table in its own scroll container, so a phone never scrolls sideways', async () => {
    // The card's four columns are `white-space: nowrap` and add up to more than a
    // phone is wide (measured: 517px against a 390px viewport). Without a scroll
    // container the table widens the PAGE, and the whole profile — hero, chart,
    // every card — slides under the thumb. That is what shipped, and it is not
    // shippable on a table-tennis app people read standing next to a table.
    //
    // What this test proves, precisely: the table is inside the wrapper the
    // stylesheet gives `overflow-x: auto`. It does NOT prove the table scrolls —
    // jsdom has no layout engine and vitest doesn't even load the CSS, so nothing
    // here can measure a `scrollWidth`, and a test that claimed to would be
    // checking nothing. Unwrap the table (the shipped bug) and this goes red; the
    // scrolling itself is verified in a browser.
    recentMatchesDisplayPage.render()

    await recentMatchesDisplayPage.findCard()

    expect(
      recentMatchesDisplayPage.queryTableScrollContainer(),
    ).toBeInTheDocument()
  })

  it('offers no history link to a player with no matches', async () => {
    recentMatchesDisplayPage.render({ recent: buildEmptyRecentMatchesView() })

    await recentMatchesDisplayPage.findCard()

    expect(recentMatchesDisplayPage.queryEmptyState()).toBeInTheDocument()
    expect(recentMatchesDisplayPage.queryViewAllLink()).not.toBeInTheDocument()
  })
})
