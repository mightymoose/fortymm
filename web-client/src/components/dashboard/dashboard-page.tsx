import { useMemo } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useDashboard } from '@/api/dashboard'
import { Card as UICard } from '@/components/ui/card'
import type { DashboardRating, DashboardRecentResult } from '@/api/dashboard'
import { deriveEmailStatus, useSession } from '@/api/session'
import { Overline } from '@/components/overline'
import { AttentionPanel } from '@/components/dashboard/attention-panel'
import { projectAttentionPanelView } from '@/components/dashboard/attention-panel-view'
import { DashboardHeader } from '@/components/dashboard/dashboard-page/dashboard-header'
import { projectDashboardHeaderView } from '@/components/dashboard/dashboard-page/dashboard-header/dashboard-header-view'
import { RatingCard } from '@/components/dashboard/dashboard-page/rating-card'
import {
  projectRatingCardView,
  ratingStrategyLabel,
} from '@/components/dashboard/dashboard-page/rating-card/rating-card-view'
import { RecentResultsCard } from '@/components/dashboard/dashboard-page/recent-results-card'
import { projectRecentResultsCardView } from '@/components/dashboard/dashboard-page/recent-results-card/recent-results-card-view'
import { GuestPersistBanner } from '@/components/dashboard/guest-persist-banner'
import { useMediaQuery } from '@/lib/use-media-query'

// Below this viewport width the page title drops its inline action button to its
// own line and gutters tighten. Sits below the app-shell's 960px sidebar-drawer
// breakpoint so tablet-width layouts keep the roomy chrome.
const COMPACT_QUERY = '(max-width: 640px)'

const C = {
  ink950: 'var(--ink-950)',
  ink900: 'var(--ink-900)',
  ink800: 'var(--ink-800)',
  ink700: 'var(--ink-700)',
  ink600: 'var(--ink-600)',
  ink500: 'var(--ink-500)',
  chalk50: 'var(--chalk-50)',
  chalk100: 'var(--chalk-100)',
  chalk300: 'var(--chalk-300)',
  chalk500: 'var(--chalk-500)',
  ball200: 'var(--ball-200)',
  ball400: 'var(--ball-400)',
  ball500: 'var(--ball-500)',
  serve500: 'var(--serve-500)',
  warn: 'var(--warn)',
  loss: 'var(--loss)',
}

const UI = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif"

// The shared design-system Card (`@/components/ui/card`). `display: 'block'`
// neutralizes the shadcn Card's default flex/gap so callers keep full control of
// their inner layout (e.g. RatingCard re-enables flex via its own style;
// RecentResultsCard stays block).
function Card({
  children,
  padding = 20,
  style,
  className,
  ...rest
}: {
  children: ReactNode
  padding?: number | string
} & Omit<ComponentProps<'div'>, 'children'>) {
  return (
    <UICard
      className={className}
      style={{
        display: 'block',
        padding,
        position: 'relative',
        ...style,
      }}
      {...rest}
    >
      {children}
    </UICard>
  )
}

function SectionHeader({
  title,
  subtitle,
  action,
  actionTo,
  actionSearch,
}: {
  title: string
  subtitle?: string
  action?: string
  actionTo?: string
  actionSearch?: Record<string, string | undefined>
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        marginBottom: 14,
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <h2
        style={{
          margin: 0,
          font: `600 18px ${UI}`,
          color: C.chalk50,
          letterSpacing: '-0.005em',
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <span style={{ font: `400 13px ${UI}`, color: C.chalk500 }}>{subtitle}</span>
      )}
      <div style={{ flex: 1 }} />
      {action && actionTo && (
        <Link
          to={actionTo}
          search={actionSearch}
          style={{
            font: `500 13px ${UI}`,
            color: C.chalk300,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {action}
          <ChevronRight size={12} strokeWidth={1.75} />
        </Link>
      )}
    </div>
  )
}

function SkeletonCard({
  label,
  height,
}: {
  label: string
  height: number
}) {
  return (
    <div
      role="status"
      aria-busy
      aria-label={label}
      style={{
        background: C.ink800,
        border: `1px solid ${C.ink600}`,
        borderRadius: 10,
        minHeight: height,
        minWidth: 0,
      }}
    />
  )
}

function EmptyCard({ overline, body }: { overline: string; body: string }) {
  return (
    <Card style={{ minWidth: 0 }}>
      <Overline>{overline}</Overline>
      <div
        style={{
          marginTop: 10,
          font: `400 13px ${UI}`,
          color: C.chalk300,
        }}
      >
        {body}
      </div>
    </Card>
  )
}

function YourGameRow({
  rating,
  recent,
  isLoading,
  username,
}: {
  rating: DashboardRating | null
  recent: DashboardRecentResult[]
  isLoading: boolean
  username?: string
}) {
  // The grid stacks vs. splits off the row's *container* width via a CSS
  // container query (see `.your-game-grid` in index.css), not the viewport: the
  // dashboard sits in the app-shell's content column beside a 256px sidebar, so
  // just past the 960px sidebar breakpoint this column is only ~700px — too
  // narrow for two columns. `container-type: inline-size` makes this <section>
  // the query container.
  return (
    <section style={{ marginBottom: 36, containerType: 'inline-size' }}>
      <SectionHeader
        title="Your game"
        subtitle={
          rating
            ? `${ratingStrategyLabel(rating.strategy_key)} · last 30 days`
            : 'Last 30 days'
        }
        action="Full history"
        actionTo="/matches"
        actionSearch={{ q: username }}
      />
      <div className="your-game-grid">
        {isLoading ? (
          <SkeletonCard label="Loading rating" height={260} />
        ) : rating ? (
          <RatingCard view={projectRatingCardView(rating)} />
        ) : (
          <EmptyCard
            overline="Current rating"
            body="Not in a rated league yet."
          />
        )}
        {isLoading ? (
          <SkeletonCard label="Loading recent matches" height={260} />
        ) : (
          <RecentResultsCard view={projectRecentResultsCardView(recent)} />
        )}
      </div>
    </section>
  )
}

export function DashboardPage() {
  const session = useSession()
  const compact = useMediaQuery(COMPACT_QUERY)
  const dashboard = useDashboard({ enabled: session.isSuccess })
  const isLoading = dashboard.isPending
  const data = dashboard.data
  const user = session.data?.data.user
  const username = user?.username
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
        username,
      ),
    [data?.attention, data?.waiting_count, username],
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
      <DashboardHeader
        view={projectDashboardHeaderView(username)}
        compact={compact}
      />
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
