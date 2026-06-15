import { within } from '@/test/utilities'

import {
  buildRecentResultRowView,
  buildRecentResultsCardView,
} from './recent-results-card.factory'
import { recentResultsCardPage as page } from './recent-results-card.page'

describe('RecentResultsCard', () => {
  it('shows the record line and a row per result', () => {
    page.render({
      view: buildRecentResultsCardView({
        record: '1-1',
        count: 2,
        rows: [
          buildRecentResultRowView({
            matchId: 'm-win',
            opponentLabel: 'silva.r',
            opponentName: 'silva.r',
            score: '3-1',
          }),
          buildRecentResultRowView({
            matchId: 'm-loss',
            opponentLabel: 'patel.m',
            opponentName: 'patel.m',
            isWin: false,
            score: '1-3',
          }),
        ],
      }),
    })

    expect(page.getSummary()).toHaveTextContent('1-1 · last 2')
    expect(page.getRows()).toHaveLength(2)
    expect(page.getRow('silva.r')).toHaveTextContent('3-1')
    expect(page.getRow('patel.m')).toHaveTextContent('1-3')
  })

  it('renders each row\'s signed delta and date', () => {
    page.render({
      view: buildRecentResultsCardView({
        rows: [
          buildRecentResultRowView({
            opponentLabel: 'silva.r',
            opponentName: 'silva.r',
            delta: '+12',
            when: 'May 3',
          }),
        ],
      }),
    })

    const row = within(page.getRow('silva.r'))
    expect(row.getByText('+12')).toBeInTheDocument()
    expect(row.getByText('May 3')).toBeInTheDocument()
  })

  it('renders a dash for an unrated row\'s delta', () => {
    page.render({
      view: buildRecentResultsCardView({
        rows: [
          buildRecentResultRowView({
            opponentLabel: 'silva.r',
            opponentName: 'silva.r',
            delta: null,
          }),
        ],
      }),
    })

    expect(within(page.getRow('silva.r')).getByText('—')).toBeInTheDocument()
  })

  it('labels a solo match "No opponent"', () => {
    page.render({
      view: buildRecentResultsCardView({
        rows: [
          buildRecentResultRowView({
            opponentName: null,
            opponentLabel: 'No opponent',
          }),
        ],
      }),
    })

    expect(page.getRow('No opponent')).toBeInTheDocument()
  })

  it('shows a calm empty state and no rows when there are no results', () => {
    page.render({
      view: buildRecentResultsCardView({ record: '0-0', count: 0, rows: [] }),
    })

    expect(page.queryEmptyState()).toBeInTheDocument()
    expect(page.getRows()).toHaveLength(0)
  })
})
