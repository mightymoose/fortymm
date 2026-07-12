import {
  LIVE_MATCH_ID,
  RECENT_MATCH_HREF,
  buildLiveRecentMatchRowView,
  buildRecentMatchDeltaView,
  buildRecentMatchGameView,
  buildRecentMatchRowView,
  buildRecentMatchStatusView,
} from './recent-match-row.factory'
import { recentMatchRowPage } from './recent-match-row.page'

const OPPONENT = 'ada.lovelace'

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

  it('keeps a solo match in the list, as "No opponent"', async () => {
    // ADR-0008: the player-less sentinel side is rendered, not dropped.
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({ opponent: 'No opponent', isSolo: true }),
    })
    await recentMatchRowPage.findRow('No opponent')

    expect(recentMatchRowPage.getRow('No opponent')).toBeInTheDocument()
    expect(recentMatchRowPage.getStatusDot('No opponent')).toBeInTheDocument()
  })

  it('links the row through to the match — a real href, not a role="link" row (#989)', async () => {
    // The whole point of #989. A `role="link"` `<tr>` with an onClick cannot be
    // cmd-clicked, middle-clicked or opened in a new tab; only an `href` can. So
    // this asserts the URL, not the existence of a link.
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getDetailLink(OPPONENT)).toHaveAttribute(
      'href',
      RECENT_MATCH_HREF,
    )
  })

  it('points each row at its OWN match', async () => {
    // A row whose link is hardcoded — or built from the wrong row — would sail
    // through the test above. The live variant is a different match.
    recentMatchRowPage.render({ row: buildLiveRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getDetailLink(OPPONENT)).toHaveAttribute(
      'href',
      `/matches/${LIVE_MATCH_ID}`,
    )
  })

  it('names the link after the MATCH — and exposes exactly one per row', async () => {
    // The anchor is on the date cell, not the opponent's name: a link named
    // "ada.lovelace" announces a profile and delivers a match. And it is one
    // anchor stretched over the row, not four — a screen reader must not hear the
    // same link once per cell.
    recentMatchRowPage.render({ row: buildRecentMatchRowView() })
    await recentMatchRowPage.findRow(OPPONENT)

    expect(recentMatchRowPage.getDetailLink(OPPONENT)).toHaveAccessibleName(
      'Match against ada.lovelace, Mar 14',
    )
    expect(recentMatchRowPage.getRowLinks(OPPONENT)).toHaveLength(1)
  })

  it('names a solo match’s link "Solo match", not "Match against No opponent"', async () => {
    recentMatchRowPage.render({
      row: buildRecentMatchRowView({ opponent: 'No opponent', isSolo: true }),
    })
    await recentMatchRowPage.findRow('No opponent')

    expect(recentMatchRowPage.getDetailLink('No opponent')).toHaveAccessibleName(
      'Solo match, Mar 14',
    )
  })
})
