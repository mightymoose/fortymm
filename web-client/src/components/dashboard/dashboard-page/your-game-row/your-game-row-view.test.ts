import {
  dashboardRating,
  dashboardRecentResult,
} from '@/test/factories'
import { projectYourGameRowView } from './your-game-row-view'

describe('projectYourGameRowView', () => {
  it('labels the subtitle with the rating strategy when rated', () => {
    const view = projectYourGameRowView(
      dashboardRating({ strategy_key: 'glicko2' }),
      [],
      'rita.kovac',
    )
    expect(view.subtitle).toBe('Glicko-2 · last 30 days')
  })

  it('falls back to just the window when there is no rating', () => {
    const view = projectYourGameRowView(null, [], 'rita.kovac')
    expect(view.subtitle).toBe('Last 30 days')
    expect(view.rating).toBeNull()
  })

  it('scopes the full-history link to the current user', () => {
    const view = projectYourGameRowView(null, [], 'rita.kovac')
    expect(view.viewAllSearch).toEqual({ q: 'rita.kovac' })
  })

  it('composes the rating and recent card view models', () => {
    const view = projectYourGameRowView(
      dashboardRating({ current: 1612 }),
      [dashboardRecentResult({ is_win: true })],
      'rita.kovac',
    )
    expect(view.rating?.current).toBe(1612)
    expect(view.recent.record).toBe('1-0')
    expect(view.recent.count).toBe(1)
  })
})
