import { dashboardRecentResult } from '@/test/factories'

import { recentResultsCardPage } from './recent-results-card.page'

describe('RecentResultsCard', () => {
  it('shows the empty state and no table when there are no completed matches', () => {
    recentResultsCardPage.render({ rows: [] })

    expect(recentResultsCardPage.queryEmptyState()).toBeInTheDocument()
    expect(recentResultsCardPage.queryTable()).toBeNull()
  })

  it('names the table after its "Recent matches" label for screen readers (#127)', () => {
    recentResultsCardPage.render()

    expect(
      recentResultsCardPage.queryTableByName('Recent matches'),
    ).toBeInTheDocument()
  })

  it('renders a row per result with the opponent and game score', () => {
    recentResultsCardPage.render()

    expect(recentResultsCardPage.queryOpponent('silva.r')).toBeInTheDocument()
    expect(recentResultsCardPage.getRow('silva.r').getByText('3-1')).toBeInTheDocument()
    expect(recentResultsCardPage.getRow('patel.m').getByText('1-3')).toBeInTheDocument()
  })

  it('summarizes the wins-losses and window size', () => {
    recentResultsCardPage.render()

    // One win, two losses, over a window of three.
    expect(recentResultsCardPage.getSummary('1-2')).toBeInTheDocument()
    expect(recentResultsCardPage.getSummary(/last 3/)).toBeInTheDocument()
  })

  it('labels an opponent-less solo match as "No opponent"', () => {
    recentResultsCardPage.render({
      rows: [dashboardRecentResult({ opponent_username: null })],
    })

    expect(recentResultsCardPage.queryOpponent('No opponent')).toBeInTheDocument()
  })

  it('shows the signed rating delta when the match MOVED the rating', () => {
    recentResultsCardPage.render()

    const row = recentResultsCardPage.getRow('silva.r')
    expect(row.getByText('+24')).toBeInTheDocument()
    expect(row.getByLabelText('Gained 24 rating')).toBeInTheDocument()
  })

  it('shows an em dash when the match carries no rating change', () => {
    recentResultsCardPage.render()

    expect(recentResultsCardPage.getRow('patel.m').getByText('—')).toBeInTheDocument()
  })

  it('shows an em dash — never a signed number — for the match that ESTABLISHED the rating', () => {
    // The change is *present* here; only its `delta` is null. Before the fix the
    // column read the delta straight, and `null >= 0` is `true` in JS — so this
    // row would have painted a green "+null"/"+0"-ish chip for a player whose
    // rating had just come into existence (#952).
    recentResultsCardPage.render()

    const row = recentResultsCardPage.getRow('invisible-sloth')
    expect(row.getByText('—')).toBeInTheDocument()
    expect(row.queryByText(/^[+-]/)).toBeNull()
    expect(row.queryByText(/1500|null|NaN/)).toBeNull()
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
