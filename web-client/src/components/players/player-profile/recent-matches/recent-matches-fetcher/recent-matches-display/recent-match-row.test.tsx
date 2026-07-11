import {
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

    expect(recentMatchRowPage.getRow('No opponent')).toBeInTheDocument()
    expect(recentMatchRowPage.getStatusDot('No opponent')).toBeInTheDocument()
  })
})
