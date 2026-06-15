import type { DashboardResponse } from '@/api/dashboard'
import type { SessionUser } from '@/api/session'
import { deriveEmailStatus } from '@/api/session'

export interface GuestPersistBannerView {
  /** Completed match count to quote in the nudge. */
  matchCount: number
  /** Rounded current rating, or null when the user has no rated league. */
  rating: number | null
}

/**
 * Decide whether the guest-persistence banner should show, and shape its copy.
 *
 * It surfaces only for a guest (no email, no pending change, unconfirmed) who
 * has at least one completed match — "you have things to lose now". Zero-match
 * guests have nothing to persist; verified or pending-verification users have
 * already started the conversion, so both get `null` (don't render).
 */
export function projectGuestPersistBannerView(
  user: SessionUser | undefined,
  dashboard: DashboardResponse | undefined,
): GuestPersistBannerView | null {
  if (!user || !dashboard) return null
  const isGuest =
    deriveEmailStatus({
      email: user.email ?? null,
      confirmedAt: user.confirmed_at ?? null,
      pendingEmail: user.pending_email ?? null,
    }) === 'guest'
  if (!isGuest || dashboard.completed_match_count < 1) return null
  return {
    matchCount: dashboard.completed_match_count,
    rating: dashboard.rating ? Math.round(dashboard.rating.current) : null,
  }
}
