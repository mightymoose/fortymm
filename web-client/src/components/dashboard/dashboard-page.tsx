import { useMemo } from 'react'
import { useDashboard } from '@/api/dashboard'
import { useSession } from '@/api/session'
import { AttentionPanel } from '@/components/dashboard/attention-panel'
import { projectAttentionPanelView } from '@/components/dashboard/attention-panel-view'
import { DashboardHeader } from '@/components/dashboard/dashboard-page/dashboard-header'
import { projectDashboardHeaderView } from '@/components/dashboard/dashboard-page/dashboard-header/dashboard-header-view'
import { SkeletonCard } from '@/components/dashboard/dashboard-page/skeleton-card'
import { YourGameRow } from '@/components/dashboard/dashboard-page/your-game-row'
import { projectYourGameRowView } from '@/components/dashboard/dashboard-page/your-game-row/your-game-row-view'
import { GuestPersistBanner } from '@/components/dashboard/guest-persist-banner'
import { projectGuestPersistBannerView } from '@/components/dashboard/guest-persist-banner/guest-persist-banner-view'
import { useMediaQuery } from '@/lib/use-media-query'

// Below this viewport width the page title drops its inline action button to its
// own line and gutters tighten. Sits below the app-shell's 960px sidebar-drawer
// breakpoint so tablet-width layouts keep the roomy chrome.
const COMPACT_QUERY = '(max-width: 640px)'

/**
 * The /dashboard orchestrator. It owns the session-gated `useDashboard` query
 * and delegates all shaping to the section view models
 * (`projectDashboardHeaderView`, `projectAttentionPanelView`,
 * `projectYourGameRowView`) and presentational children. No bespoke markup
 * lives here beyond the page's max-width gutter.
 */
export function DashboardPage() {
  const session = useSession()
  const compact = useMediaQuery(COMPACT_QUERY)
  const dashboard = useDashboard({ enabled: session.isSuccess })
  const isLoading = dashboard.isPending
  const data = dashboard.data
  const user = session.data?.data.user
  const username = user?.username
  const guestBannerView = projectGuestPersistBannerView(user, data)
  const attentionView = useMemo(
    () =>
      projectAttentionPanelView(
        data?.attention ?? [],
        data?.waiting_count ?? 0,
        username,
      ),
    [data?.attention, data?.waiting_count, username],
  )
  const yourGameView = useMemo(
    () =>
      projectYourGameRowView(
        data?.rating ?? null,
        data?.recent_results ?? [],
        username,
      ),
    [data?.rating, data?.recent_results, username],
  )
  return (
    <div
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: compact ? '20px 16px 32px' : '28px 32px 40px',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {guestBannerView && <GuestPersistBanner view={guestBannerView} />}
      <DashboardHeader
        view={projectDashboardHeaderView(username)}
        compact={compact}
      />
      {isLoading ? (
        <div style={{ marginBottom: 32 }}>
          <SkeletonCard label="Loading attention panel" height={160} />
        </div>
      ) : (
        <AttentionPanel view={attentionView} />
      )}
      <YourGameRow view={yourGameView} isLoading={isLoading} />
    </div>
  )
}
