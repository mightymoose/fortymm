import {
  buildLiveRecentMatchRowView,
  buildRecentMatchDeltaView,
  buildRecentMatchGameView,
  buildRecentMatchOpponentView,
  buildRecentMatchRowView,
  buildRecentMatchStatusView,
  buildSoloRecentMatchRowView,
} from './recent-match-row.factory'
import { recentMatchRowPage } from './recent-match-row.page'

const OPPONENT = 'ada.lovelace'
const NO_OPPONENT = 'No opponent'

describe('RecentMatchRow', () => {
  it('renders a decided win as a green dot, its game chips and a signed delta', async () => {
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveAccessibleName(
      'Won',
    )
    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveClass(
      'recent-matches__dot--won',
    )
    expect(recentMatchRowPage.getScoreCell(OPPONENT)).toHaveTextContent(
      '117911116',
    )
    expect(recentMatchRowPage.getDeltaCell(OPPONENT)).toHaveTextContent('+12')
    expect(recentMatchRowPage.getWhenCell(OPPONENT)).toHaveTextContent('Mar 14')
  })

  it('tones a losing delta as a loss and names it for a screen reader', async () => {
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({
        status: buildRecentMatchStatusView({ tone: 'lost', label: 'Lost' }),
        delta: buildRecentMatchDeltaView({
          label: '-14',
          ariaLabel: 'Lost 14 rating',
          tone: 'loss',
        }),
      }),
    })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveClass(
      'recent-matches__dot--lost',
    )
    expect(recentMatchRowPage.getDeltaCell(OPPONENT)).toHaveTextContent('-14')
    expect(
      recentMatchRowPage.getDeltaCell(OPPONENT).querySelector('[role="img"]'),
    ).toHaveAccessibleName('Lost 14 rating')
  })

  it('carries a live match on its dot and in the score cell — never a score', async () => {
    // The result chip is gone: if the dot and the score cell don't say "Live",
    // nothing does.
    recentMatchRowPage.render({ row: buildLiveRecentMatchRowView() })

    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveAccessibleName(
      'Live',
    )
    expect(recentMatchRowPage.getStatusDot(OPPONENT)).toHaveClass(
      'recent-matches__dot--live',
    )
    expect(recentMatchRowPage.getScoreCell(OPPONENT)).toHaveTextContent('Live')
  })

  it('prints an em dash — never "+0" — when no rating moved', async () => {
    recentMatchRowPage.render({ row: buildRecentMatchRowView({ delta: null }) })

    await recentMatchRowPage.findRow(OPPONENT)

    const delta = recentMatchRowPage.getDeltaCell(OPPONENT)
    expect(delta).toHaveTextContent('—')
    expect(delta).not.toHaveTextContent('0')
    expect(delta.querySelector('[role="img"]')).toHaveAccessibleName(
      'No rating change',
    )
  })

  it('marks the games the player lost apart from the ones they won', async () => {
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({
        score: {
          kind: 'games',
          games: [
            buildRecentMatchGameView({ mine: 11, theirs: 7, won: true }),
            buildRecentMatchGameView({ mine: 9, theirs: 11, won: false }),
          ],
        },
      }),
    })

    await recentMatchRowPage.findRow(OPPONENT)

    const chips = recentMatchRowPage
      .getScoreCell(OPPONENT)
      .querySelectorAll('.player-profile__game')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveClass('player-profile__game--won')
    expect(chips[1]).toHaveClass('player-profile__game--lost')
  })

  it("links the opponent's name to that opponent's profile", async () => {
    // The card named its opponents in plain text — the most obvious next step on
    // the page, and there was nothing to click. The id was on the wire the whole
    // time; the row now spends it.
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({
        opponent: buildRecentMatchOpponentView({
          id: 'p-42',
          name: 'grace.hopper',
        }),
      }),
    })

    await recentMatchRowPage.findRow('grace.hopper')

    expect(recentMatchRowPage.getOpponentLink('grace.hopper')).toBeVisible()
    expect(recentMatchRowPage.getOpponentHref('grace.hopper')).toBe(
      '/players/p-42',
    )
  })

  it('keeps a solo match in the list, as "No opponent"', async () => {
    // ADR-0008: the player-less sentinel side is rendered, not dropped.
    recentMatchRowPage.render({ row: buildSoloRecentMatchRowView() })

    await recentMatchRowPage.findRow(NO_OPPONENT)

    expect(recentMatchRowPage.getRow(NO_OPPONENT)).toBeInTheDocument()
    expect(recentMatchRowPage.getStatusDot(NO_OPPONENT)).toBeInTheDocument()
  })

  it('does NOT link a solo match — there is nobody to link to', async () => {
    // The null-id case, and the one a naive fix breaks: `id` is null exactly for
    // the player-less sentinel side, so a link built from it would point at
    // `/players/null` and land the reader on a not-found page. "No opponent" is
    // an absence, not a player: it must be plain text.
    recentMatchRowPage.render({ row: buildSoloRecentMatchRowView() })

    await recentMatchRowPage.findRow(NO_OPPONENT)

    // Not "there's no link *with that name*" — there is no link in the cell at
    // all, and nothing anywhere in the row pointing at a player.
    expect(recentMatchRowPage.queryOpponentLink(NO_OPPONENT)).toBeNull()
    expect(
      recentMatchRowPage.getRow(NO_OPPONENT).querySelectorAll('a'),
    ).toHaveLength(0)
    expect(recentMatchRowPage.getRow(NO_OPPONENT).innerHTML).not.toContain(
      '/players/',
    )
  })
})
