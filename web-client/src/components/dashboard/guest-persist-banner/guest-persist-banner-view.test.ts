import {
  dashboardRating,
  dashboardResponse,
  sessionUser,
} from '@/test/factories'
import { projectGuestPersistBannerView } from './guest-persist-banner-view'

describe('projectGuestPersistBannerView', () => {
  it('shows for a guest with completed matches and quotes count + rating', () => {
    const view = projectGuestPersistBannerView(
      sessionUser(),
      dashboardResponse({
        completed_match_count: 4,
        rating: dashboardRating({ current: 1846.6 }),
      }),
    )

    expect(view).toEqual({ matchCount: 4, rating: 1847 })
  })

  it('drops the rating when the user has no rated league', () => {
    const view = projectGuestPersistBannerView(
      sessionUser(),
      dashboardResponse({ completed_match_count: 1, rating: null }),
    )

    expect(view).toEqual({ matchCount: 1, rating: null })
  })

  it('hides for a zero-match guest', () => {
    const view = projectGuestPersistBannerView(
      sessionUser(),
      dashboardResponse({ completed_match_count: 0, rating: null }),
    )

    expect(view).toBeNull()
  })

  it('hides for a verified user regardless of match count', () => {
    const view = projectGuestPersistBannerView(
      sessionUser({ email: 'rita@example.com', confirmed_at: '2026-05-01T10:00:00Z' }),
      dashboardResponse({ completed_match_count: 12 }),
    )

    expect(view).toBeNull()
  })

  it('hides for a user with a pending email change', () => {
    const view = projectGuestPersistBannerView(
      sessionUser({ pending_email: 'rita@example.com' }),
      dashboardResponse({ completed_match_count: 5 }),
    )

    expect(view).toBeNull()
  })

  it('hides when the session or dashboard payload is missing', () => {
    expect(
      projectGuestPersistBannerView(undefined, dashboardResponse()),
    ).toBeNull()
    expect(projectGuestPersistBannerView(sessionUser(), undefined)).toBeNull()
  })
})
