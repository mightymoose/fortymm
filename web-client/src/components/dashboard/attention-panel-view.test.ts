import { dashboardAttentionItem } from '@/test/factories'
import {
  isAttentionPanelEmpty,
  projectAttentionPanelView,
} from './attention-panel-view'

describe('projectAttentionPanelView', () => {
  it('caps visible rows at 3 and reports the overflow', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      dashboardAttentionItem({ match_id: `m-${i}`, kind: 'score' }),
    )

    const view = projectAttentionPanelView(items, 0)

    expect(view.rows).toHaveLength(3)
    expect(view.rows.map((r) => r.matchId)).toEqual(['m-0', 'm-1', 'm-2'])
    expect(view.overflowCount).toBe(2)
  })

  it('derives overflow from the server total, not the capped row list', () => {
    // The server caps the returned rows (ATTENTION_BANNERS_LIMIT) but reports
    // the true actionable total, so the footer "+N more" must subtract the
    // visible 3 from that total — never from the truncated array length.
    const items = Array.from({ length: 10 }, (_, i) =>
      dashboardAttentionItem({ match_id: `m-${i}`, kind: 'score' }),
    )

    const view = projectAttentionPanelView(items, 0, 47)

    expect(view.rows).toHaveLength(3)
    expect(view.overflowCount).toBe(44)
  })

  it('marks only the highest-priority visible bucket as primary', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({ match_id: 'm-review', kind: 'review' }),
        dashboardAttentionItem({ match_id: 'm-score', kind: 'score' }),
      ],
      0,
    )

    expect(view.rows.map((r) => r.primary)).toEqual([true, false])
  })

  it('makes every same-type row primary', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({ kind: 'score', affects_rating: true }),
        dashboardAttentionItem({ kind: 'score', affects_rating: true }),
      ],
      0,
    )

    expect(view.rows.map((r) => r.primary)).toEqual([true, true])
  })

  it('keeps rated and unrated score rows in the same primary bucket', () => {
    // Both are `Enter score` actions; the rated/unrated split only governs
    // ordering, never button emphasis (issue #565).
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({ kind: 'score', affects_rating: true }),
        dashboardAttentionItem({ kind: 'score', affects_rating: true }),
        dashboardAttentionItem({ kind: 'score', affects_rating: false }),
      ],
      0,
    )

    expect(view.rows.map((r) => r.primary)).toEqual([true, true, true])
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
    )

    expect(view.rows[0].headline).toBe('vs lively.otter')
    expect(view.rows[1].headline).toBe('No opponent')
  })

  it('carries a parsed retirement deadline onto the row', () => {
    const deadline = '2026-07-09T12:00:00Z'
    const view = projectAttentionPanelView(
      [dashboardAttentionItem({ retirement_deadline: deadline })],
      0,
    )

    expect(view.rows[0].retirementDeadline).toBe(deadline)
  })

  it('projects a null deadline when the item carries none', () => {
    const view = projectAttentionPanelView(
      [dashboardAttentionItem({ retirement_deadline: null })],
      0,
    )

    expect(view.rows[0].retirementDeadline).toBeNull()
  })

  it('treats an absent deadline field as null', () => {
    // `retirement_deadline` is optional on the wire; `undefined` must map to
    // null, not leak through.
    const item = dashboardAttentionItem()
    delete (item as { retirement_deadline?: string | null }).retirement_deadline
    const view = projectAttentionPanelView([item], 0)

    expect(view.rows[0].retirementDeadline).toBeNull()
  })

  it('soft-fails a malformed deadline to null rather than throwing', () => {
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({
          retirement_deadline: 'not-a-date' as unknown as string,
        }),
      ],
      0,
    )

    expect(view.rows[0].retirementDeadline).toBeNull()
  })

  it('preserves server order regardless of deadline (no deadline-based sort)', () => {
    // P2-1 (deadline sorting) is deferred — the server order must be echoed
    // as-is even when a later row has a sooner deadline.
    const view = projectAttentionPanelView(
      [
        dashboardAttentionItem({
          match_id: 'm-far',
          retirement_deadline: '2026-07-20T12:00:00Z',
        }),
        dashboardAttentionItem({
          match_id: 'm-soon',
          retirement_deadline: '2026-07-09T12:00:00Z',
        }),
      ],
      0,
    )

    expect(view.rows.map((r) => r.matchId)).toEqual(['m-far', 'm-soon'])
  })

  it('passes through the waiting count and points "View all" at the Attention tab', () => {
    const view = projectAttentionPanelView([], 4)

    expect(view.rows).toHaveLength(0)
    expect(view.overflowCount).toBe(0)
    expect(view.waitingCount).toBe(4)
    expect(view.viewAllSearch).toEqual({ status: 'attention' })
  })
})

describe('isAttentionPanelEmpty', () => {
  it('is empty when there are no actionable rows', () => {
    expect(isAttentionPanelEmpty(projectAttentionPanelView([], 0))).toBe(true)
  })

  it('is still empty when matches are waiting on others but there is nothing to act on', () => {
    // The panel is purely a to-do list — matches waiting on others don't keep
    // it on screen when the user has nothing to do.
    expect(isAttentionPanelEmpty(projectAttentionPanelView([], 3))).toBe(true)
  })

  it('is not empty when there are actionable rows', () => {
    const view = projectAttentionPanelView(
      [dashboardAttentionItem({ kind: 'score' })],
      0,
    )
    expect(isAttentionPanelEmpty(view)).toBe(false)
  })

  it('is not empty when overflow rolls extra items into the footer', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      dashboardAttentionItem({ match_id: `m-${i}`, kind: 'score' }),
    )
    expect(isAttentionPanelEmpty(projectAttentionPanelView(items, 0))).toBe(
      false,
    )
  })
})
