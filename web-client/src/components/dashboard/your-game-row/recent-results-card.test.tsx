import { dashboardRecentResult } from '@/test/factories'

import { recentResultsCardPage } from './recent-results-card.page'

describe('RecentResultsCard', () => {
  it('shows the empty state and no table when there are no completed matches', () => {
    recentResultsCardPage.render({ rows: [] })

    expect(recentResultsCardPage.queryEmptyState()).toBeInTheDocument()
    expect(recentResultsCardPage.queryTable()).toBeNull()
  })

  it('renders a row per result with the opponent and game score', () => {
    recentResultsCardPage.render()

    expect(recentResultsCardPage.queryOpponent('silva.r')).toBeInTheDocument()
    expect(recentResultsCardPage.getRow('silva.r').getByText('3-1')).toBeInTheDocument()
    expect(recentResultsCardPage.getRow('patel.m').getByText('1-3')).toBeInTheDocument()
  })

  it('summarizes the wins-losses and window size', () => {
    recentResultsCardPage.render()

    // One win, one loss, over a window of two.
    expect(recentResultsCardPage.getSummary('1-1')).toBeInTheDocument()
    expect(recentResultsCardPage.getSummary(/last 2/)).toBeInTheDocument()
  })

  it('labels an opponent-less solo match as "No opponent"', () => {
    recentResultsCardPage.render({
      rows: [dashboardRecentResult({ opponent_username: null })],
    })

    expect(recentResultsCardPage.queryOpponent('No opponent')).toBeInTheDocument()
  })

  it('shows the signed rating delta when the match changed the rating', () => {
    recentResultsCardPage.render()

    expect(recentResultsCardPage.getRow('silva.r').getByText('+24')).toBeInTheDocument()
  })

  it('shows an em dash when the match carries no rating change', () => {
    recentResultsCardPage.render()

    expect(recentResultsCardPage.getRow('patel.m').getByText('—')).toBeInTheDocument()
  })

  it('tones a winning score with the serve color and a loss with the loss color', () => {
    recentResultsCardPage.render()

    expect(recentResultsCardPage.getRow('silva.r').getByText('3-1')).toHaveStyle({
      color: 'var(--serve-500)',
    })
    expect(recentResultsCardPage.getRow('patel.m').getByText('1-3')).toHaveStyle({
      color: 'var(--loss)',
    })
  })
})
