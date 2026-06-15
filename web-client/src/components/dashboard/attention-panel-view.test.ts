import { dashboardAttentionItem } from '@/test/factories'
import { projectAttentionPanelView } from './attention-panel-view'

describe('projectAttentionPanelView', () => {
  it('caps visible rows at 3 and reports the overflow', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      dashboardAttentionItem({ match_id: `m-${i}`, kind: 'score' }),
    )

    const view = projectAttentionPanelView(items, 0, 'rita.kovac')

    expect(view.rows).toHaveLength(3)
    expect(view.rows.map((r) => r.matchId)).toEqual(['m-0', 'm-1', 'm-2'])
    expect(view.overflowCount).toBe(2)
  })

  it('marks only the highest-priority visible bucket as primary', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({ match_id: 'm-dispute', kind: 'dispute' }),
        dashboardAttentionItem({ match_id: 'm-review', kind: 'review' }),
        dashboardAttentionItem({ match_id: 'm-score', kind: 'score' }),
      ],
      0,
      'rita.kovac',
    )

    expect(view.rows.map((r) => r.primary)).toEqual([true, false, false])
  })

  it('makes every same-type row primary', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({ kind: 'score', affects_rating: true }),
        dashboardAttentionItem({ kind: 'score', affects_rating: true }),
      ],
      0,
      'rita.kovac',
    )

    expect(view.rows.map((r) => r.primary)).toEqual([true, true])
  })

  it('routes a score row to the scoring page and review/dispute to match detail', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({
          match_id: 'm-score',
          kind: 'score',
          current_game_number: 3,
        }),
        dashboardAttentionItem({
          match_id: 'm-review',
          kind: 'review',
          current_game_number: null,
        }),
      ],
      0,
      'rita.kovac',
    )

    expect(view.rows[0].route).toEqual({
      to: '/matches/$matchId/games/$gameNumber/scores/new',
      params: { matchId: 'm-score', gameNumber: '3' },
    })
    expect(view.rows[1].route).toEqual({
      to: '/matches/$matchId',
      params: { matchId: 'm-review' },
    })
  })

  it('routes a decided-but-unposted score row (no game number) to match detail', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({
          match_id: 'm-decided',
          kind: 'score',
          current_game_number: null,
        }),
      ],
      0,
      'rita.kovac',
    )

    expect(view.rows[0].route).toEqual({
      to: '/matches/$matchId',
      params: { matchId: 'm-decided' },
    })
  })

  it('builds the headline from the opponent handle, falling back to "No opponent"', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({ opponent_username: 'lively.otter' }),
        dashboardAttentionItem({ opponent_username: null }),
      ],
      0,
      'rita.kovac',
    )

    expect(view.rows[0].headline).toBe('vs lively.otter')
    expect(view.rows[1].headline).toBe('No opponent')
  })

  it('passes through the waiting count and scopes "View all" to the user', () => {
    const view = projectAttentionPanelView([], 4, 'rita.kovac')

    expect(view.rows).toHaveLength(0)
    expect(view.overflowCount).toBe(0)
    expect(view.waitingCount).toBe(4)
    expect(view.viewAllSearch).toEqual({ q: 'rita.kovac' })
  })
})
