import { useMemo } from 'react'
import { useDashboard } from '@/api/dashboard'
import { deriveEmailStatus, useSession } from '@/api/session'
import { AttentionPanel } from '@/components/dashboard/attention-panel'
import { projectAttentionPanelView } from '@/components/dashboard/attention-panel-view'
import { GuestPersistBanner } from '@/components/dashboard/guest-persist-banner'
import { PageTitle } from '@/components/dashboard/page-title'
import { SkeletonCard } from '@/components/dashboard/skeleton-card'
import { YourGameRow } from '@/components/dashboard/your-game-row'
import { useMediaQuery } from '@/lib/use-media-query'

// Below this viewport width the page title drops its inline action button to its
// own line and gutters tighten. Sits below the app-shell's 960px sidebar-drawer
// breakpoint so tablet-width layouts keep the roomy chrome.
const COMPACT_QUERY = '(max-width: 640px)'

export function DashboardPage() {
  const session = useSession()
  const compact = useMediaQuery(COMPACT_QUERY)
  const dashboard = useDashboard({ enabled: session.isSuccess })
  const isLoading = dashboard.isPending
  const data = dashboard.data
  const user = session.data?.data.user
  const username = user?.username
  const greeting = username ? `Hi, @${username}` : 'Hi'
  // Guest with at least one completed match — "you have things to lose now".
  // Zero-match guests and verified/pending-verification users never see this.
  const isGuest =
    user !== undefined &&
    deriveEmailStatus({
      email: user.email ?? null,
      confirmedAt: user.confirmed_at ?? null,
      pendingEmail: user.pending_email ?? null,
    }) === 'guest'
  const showGuestPersistBanner = isGuest && (data?.completed_match_count ?? 0) >= 1
  const attentionView = useMemo(
    () =>
      projectAttentionPanelView(
        data?.attention ?? [],
        data?.waiting_count ?? 0,
        data?.attention_total_count ?? 0,
      ),
    [data?.attention, data?.waiting_count, data?.attention_total_count],
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
      {showGuestPersistBanner && data && (
        <GuestPersistBanner
          matchCount={data.completed_match_count}
          rating={data.rating ? Math.round(data.rating.current) : null}
        />
      )}
      <PageTitle greeting={greeting} compact={compact} />
      {isLoading ? (
        <div style={{ marginBottom: 32 }}>
          <SkeletonCard label="Loading attention panel" height={160} />
        </div>
      ) : (
        <AttentionPanel
          view={attentionView}
        />
      )}
      <YourGameRow
        rating={data?.rating ?? null}
        recent={data?.recent_results ?? []}
        isLoading={isLoading}
        username={username}
      />
    </div>
  )
}
