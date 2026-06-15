import { dashboardRecentResult } from '@/test/factories'
import { projectRecentResultsCardView } from './recent-results-card-view'

describe('projectRecentResultsCardView', () => {
  it('tallies the win-loss record and last-N count', () => {
    const view = projectRecentResultsCardView([
      dashboardRecentResult({ is_win: true }),
      dashboardRecentResult({ is_win: true }),
      dashboardRecentResult({ is_win: false }),
    ])

    expect(view.record).toBe('2-1')
    expect(view.count).toBe(3)
    expect(view.rows).toHaveLength(3)
  })

  it('is 0-0 with no rows', () => {
    const view = projectRecentResultsCardView([])
    expect(view.record).toBe('0-0')
    expect(view.count).toBe(0)
  })

  it('projects the per-row display fields from the viewer perspective', () => {
    const [row] = projectRecentResultsCardView([
      dashboardRecentResult({
        match_id: 'm-1',
        opponent_username: 'silva.r',
        is_win: true,
        my_games_won: 3,
        opponent_games_won: 1,
        completed_at: '2026-05-03T09:00:00Z',
        my_rating_change: { before: 1500, after: 1512, delta: 12 },
      }),
    ]).rows

    expect(row).toEqual({
      matchId: 'm-1',
      opponentName: 'silva.r',
      opponentLabel: 'silva.r',
      isWin: true,
      score: '3-1',
      delta: '+12',
      when: 'May 3',
    })
  })

  it('labels a solo match "No opponent" and renders a null delta when unrated', () => {
    const [row] = projectRecentResultsCardView([
      dashboardRecentResult({
        opponent_username: null,
        my_rating_change: null,
      }),
    ]).rows

    expect(row.opponentName).toBeNull()
    expect(row.opponentLabel).toBe('No opponent')
    expect(row.delta).toBeNull()
  })

  it('renders a negative delta with its sign for a loss', () => {
    const [row] = projectRecentResultsCardView([
      dashboardRecentResult({
        is_win: false,
        my_rating_change: { before: 1500, after: 1486, delta: -14 },
      }),
    ]).rows

    expect(row.delta).toBe('-14')
  })
})
