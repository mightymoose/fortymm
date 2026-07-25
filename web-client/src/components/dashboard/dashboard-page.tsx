import { useMemo } from 'react'
import { useDashboard } from '@/api/dashboard'
import { deriveEmailStatus, useSession } from '@/api/session'
import { AttentionPanel } from '@/components/dashboard/attention-panel'
import { AttentionPanelSkeleton } from '@/components/dashboard/attention-panel-skeleton'
import { projectAttentionPanelView } from '@/components/dashboard/attention-panel-view'
import { FirstMatchDashboard } from '@/components/dashboard/first-match/first-match-dashboard'
import { GuestPersistBanner } from '@/components/dashboard/guest-persist-banner'
import { PageTitle } from '@/components/dashboard/page-title'
import { TournamentPanel } from '@/components/dashboard/tournament-panel'
import { projectTournamentPanelViews } from '@/components/dashboard/tournament-panel-view'
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
  // Explicitly drop the user on a session error so the greeting falls back to a
  // bare "Hi" rather than reading a stale value — mirrors UserMenu's
  // `!isError && data ? … : 'Guest'` pattern (#287).
  const user =
    !session.isError && session.data ? session.data.data.user : undefined
  const username = user?.username
  const greeting = username ? `Hi, ${username}` : 'Hi'
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
  // Truly-empty only: an attention item (e.g. a not-yet-completed match
  // waiting to be scored) or a passively-waiting match (e.g. a proposed
  // result awaiting the opponent's acceptance — waiting_count, disjoint from
  // attention_total_count) can exist alongside zero *completed* matches, and
  // the first-match hero must not hide that live match or invite starting a
  // duplicate. Gated on `!isLoading` so the pending skeleton renders as
  // before — we don't know the layout until the query resolves.
  const isFirstMatch =
    !isLoading &&
    data !== undefined &&
    data.completed_match_count === 0 &&
    data.attention_total_count === 0 &&
    data.waiting_count === 0
  // The tournament panels that top the page while the user is playing in a live
  // tournament — `[]` the rest of the time, which is almost always.
  const tournamentViews = useMemo(
    () => projectTournamentPanelViews(data?.tournaments ?? [], username),
    [data?.tournaments, username],
  )
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
          // The rating block is always present now, but only the RATED arm
          // carries a `current`; drop the rating fragment when it's null.
          rating={
            data.rating.current !== null
              ? Math.round(data.rating.current)
              : null
          }
        />
      )}
      <PageTitle
        greeting={greeting}
        compact={compact}
        loading={session.isLoading}
      />
      {/* Above everything else on the page, and outside the first-match branch:
          while a tournament is being played, the match in front of you outranks
          every other to-do on the dashboard — including the "log your first
          match" hero, which a player standing at a table has already moved past
          even if none of their matches has been completed yet. */}
      {tournamentViews.map((tournamentView) => (
        <TournamentPanel key={tournamentView.tournamentId} view={tournamentView} />
      ))}
      {isFirstMatch ? (
        <FirstMatchDashboard />
      ) : (
        <>
          {isLoading ? (
            <AttentionPanelSkeleton />
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
        </>
      )}
    </div>
  )
}
