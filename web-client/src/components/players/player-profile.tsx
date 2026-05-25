import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'

import {
  usePlayerMatches,
  type PlayerDetail,
  type PlayerMatchListResponse,
  type PlayerMatchRow,
} from '@/api/players'
import { Button } from '@/components/ui/button'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination'
import { UserAvatar } from '@/components/ui/user-avatar'

import './player-profile.css'

/**
 * Profile surface shared by the authed `/players/$userId` route and the
 * public `/p/players/$username` route. Renders a Bebas hero (username +
 * rating) and a per-player matches list — no tabs.
 *
 * The route fetches the player and passes it in; this component fetches the
 * matches itself (one query per loaded player.id). Both fetches are
 * `throwOnError`, so the player query routes failures to the route-level
 * `errorComponent`; the matches query renders its own inline retry inside
 * the body so a transient match-fetch failure doesn't blank the whole page.
 */
export interface PlayerProfileProps {
  /** The loaded player + bundled first-page matches, or null while the
   * route's profile query is pending. */
  player: PlayerDetail | null
  /** True while the route's profile query is pending — drives the hero
   * skeleton. */
  isPending: boolean
  /** When false (the public route, for anonymous viewers) match rows render as
   * static panels instead of links — there's nothing under /matches/:id to
   * navigate to without a session. */
  matchesAreLinks?: boolean
  /** True when the component is rendered without AppShell (the public route).
   * Zeros out the `--topbar-h` offset so the fixed-height layout fills the
   * viewport instead of leaving a 64px dead strip at the bottom. */
  standalone?: boolean
  /** 1-based page for the matches list. Owned by the route so pagination
   * state lives in the URL. */
  page: number
  onPageChange: (next: number) => void
}

const PAGE_SIZE = 25

export function PlayerProfile({
  player,
  isPending,
  matchesAreLinks = true,
  standalone = false,
  page,
  onPageChange,
}: PlayerProfileProps) {
  const rootClass =
    'player-profile dark fortymm-theme' +
    (standalone ? ' player-profile--standalone' : '')
  return (
    <div className={rootClass}>
      <Hero player={player} isPending={isPending} />
      <div className="player-profile__body">
        {player && (
          <MatchesSection
            playerId={player.id}
            // Bundled first-page matches from the profile endpoint —
            // MatchesSection hydrates page 1 from this so we don't make
            // a second request on initial load.
            initialMatches={player.matches}
            asLinks={matchesAreLinks}
            page={page}
            onPageChange={onPageChange}
          />
        )}
      </div>
    </div>
  )
}

function Hero({
  player,
  isPending,
}: {
  // Only reads the PlayerSummary fields (id/username/rating/wins/losses);
  // the embedded `matches` on PlayerDetail is consumed by MatchesSection.
  player: PlayerDetail | null
  isPending: boolean
}) {
  if (isPending || player === null) {
    return (
      <header className="player-profile__hero" aria-busy="true">
        <div className="player-profile__hero-row">
          <div className="player-profile__avatar-ring">
            <span
              className="player-profile__hero-avatar-skeleton"
              aria-hidden="true"
            />
            <span
              aria-hidden="true"
              className="player-profile__avatar-dashed"
            />
          </div>
          <div className="player-profile__name-wrap">
            <div className="player-profile__overline">FortyMM Player</div>
            <div
              className="player-profile__hero-name-skeleton"
              aria-hidden="true"
            />
            <div
              className="player-profile__hero-sub-skeleton"
              aria-hidden="true"
            />
          </div>
          <div className="player-profile__hero-rating">
            <div className="player-profile__overline">FortyMM Rating</div>
            <div
              className="player-profile__hero-rating-chip player-profile__hero-rating-chip--skeleton"
              aria-hidden="true"
            />
          </div>
        </div>
      </header>
    )
  }
  return (
    <header className="player-profile__hero">
      <div className="player-profile__hero-row">
        <div className="player-profile__avatar-ring">
          <UserAvatar name={player.username} size={120} ring />
          <span aria-hidden="true" className="player-profile__avatar-dashed" />
        </div>
        <div className="player-profile__name-wrap">
          <div className="player-profile__overline">FortyMM Player</div>
          <h1 className="player-profile__name">
            {player.username.toUpperCase()}
            <span className="player-profile__name-dot">.</span>
          </h1>
          <div className="player-profile__sub">
            <span className="player-profile__sub-record">
              <span className="player-profile__sub-record-mono">
                {player.wins}
              </span>
              <span style={{ color: 'var(--fg-3)' }}> – </span>
              <span className="player-profile__sub-record-mono">
                {player.losses}
              </span>
              <span style={{ color: 'var(--fg-3)', marginLeft: 6 }}>
                W–L
              </span>
            </span>
          </div>
        </div>
        <div className="player-profile__hero-rating">
          <div className="player-profile__overline">FortyMM Rating</div>
          <div className="player-profile__hero-rating-chip">
            {player.rating == null ? '—' : Math.round(player.rating)}
          </div>
          {player.rating == null && (
            <div className="player-profile__hero-rating-meta">Unrated</div>
          )}
        </div>
      </div>
    </header>
  )
}

function MatchesSection({
  playerId,
  initialMatches,
  asLinks,
  page,
  onPageChange,
}: {
  playerId: string
  /** First-page matches from the profile bundle. Used as `initialData`
   * for page 1 so the section paints synchronously on initial load.
   * Page 2+ fetches normally — the bundled response only carries the
   * first page, and its `page_size` agrees with the FE PAGE_SIZE
   * (both default to 25). */
  initialMatches: PlayerMatchListResponse
  asLinks: boolean
  page: number
  onPageChange: (next: number) => void
}) {
  const { data, isPending, isError, refetch } = usePlayerMatches(
    playerId,
    { page, page_size: PAGE_SIZE },
    { initialData: page === 1 ? initialMatches : undefined },
  )
  const rows = data?.items ?? []
  const total = data?.total ?? 0

  return (
    <section className="player-profile__section">
      <div className="player-profile__section-header">
        <span className="player-profile__section-title">Matches</span>
        {data && (
          <span className="player-profile__section-count">{total}</span>
        )}
      </div>
      <div className="player-profile__table-wrap">
        {isError ? (
          <MatchesError onRetry={() => void refetch()} />
        ) : isPending ? (
          <MatchesSkeleton />
        ) : rows.length === 0 ? (
          <MatchesEmpty />
        ) : (
          <table className="matches">
            <thead>
              <tr>
                <th style={{ width: 120 }}>Date</th>
                <th>Opponent</th>
                <th style={{ width: 260 }}>Score</th>
                <th style={{ width: 90 }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <MatchRowComponent key={m.id} m={m} asLink={asLinks} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {total > PAGE_SIZE && (
        <PaginationFooter
          page={page}
          setPage={onPageChange}
          total={total}
          pageSize={PAGE_SIZE}
        />
      )}
    </section>
  )
}

function MatchesSkeleton() {
  return (
    <table className="matches" aria-busy="true">
      <thead>
        <tr>
          <th style={{ width: 120 }}>Date</th>
          <th>Opponent</th>
          <th style={{ width: 260 }}>Score</th>
          <th style={{ width: 90 }}>Result</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 6 }).map((_, i) => (
          <tr key={i} className="skeleton-row" aria-hidden="true">
            <td colSpan={4}>
              <div className="skeleton-line" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MatchesEmpty() {
  return (
    <div
      style={{
        padding: '56px 24px',
        textAlign: 'center',
        color: 'var(--fg-3)',
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--fg-2)',
          marginBottom: 6,
        }}
      >
        No matches yet
      </div>
      <div>This player hasn’t played any rated matches.</div>
    </div>
  )
}

function MatchesError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        padding: '40px 24px',
        textAlign: 'center',
        color: 'var(--fg-3)',
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--fg-2)',
          marginBottom: 6,
        }}
      >
        Couldn’t load matches
      </div>
      <div style={{ marginBottom: 16, fontSize: 13 }}>
        Something went wrong reaching the server.
      </div>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

function MatchRowComponent({
  m,
  asLink,
}: {
  m: PlayerMatchRow
  asLink: boolean
}) {
  // Match-detail routes aren't wired up in this scope, so even when `asLink`
  // is true the row renders as a static panel. The prop is kept for future
  // route wiring (and so the public route can opt out).
  void asLink
  const opponentName = m.opponent.username ?? 'No opponent'
  const isNoOpp = m.opponent.username === null
  const won = m.result === 'W'
  const lost = m.result === 'L'
  return (
    <tr>
      <td>
        <span className="time-cell">
          <span className="strong">{formatDate(m.created_at)}</span>
        </span>
      </td>
      <td>
        <div className="player">
          {isNoOpp ? (
            <UserAvatar name={null} size={26} />
          ) : (
            <UserAvatar name={opponentName} size={26} />
          )}
          <span
            className="player-name"
            style={isNoOpp ? { color: 'var(--fg-3)', fontStyle: 'italic' } : undefined}
          >
            {opponentName}
          </span>
        </div>
      </td>
      <td>
        {m.sets.length === 0 ? (
          <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
            —
          </span>
        ) : (
          <div className="player-profile__sets">
            {m.sets.map((s, i) => {
              const setWon = s.mine > s.theirs
              return (
                <div
                  key={i}
                  className={
                    'player-profile__set ' +
                    (setWon
                      ? 'player-profile__set--won'
                      : 'player-profile__set--lost')
                  }
                >
                  <span className="player-profile__set-mine">{s.mine}</span>
                  <span className="player-profile__set-theirs">{s.theirs}</span>
                </div>
              )
            })}
          </div>
        )}
      </td>
      <td>
        <ResultChip status={m.status} won={won} lost={lost} />
      </td>
    </tr>
  )
}

function ResultChip({
  status,
  won,
  lost,
}: {
  status: PlayerMatchRow['status']
  won: boolean
  lost: boolean
}) {
  if (status === 'in_progress') {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--live">
        LIVE
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--pending">
        UP NEXT
      </span>
    )
  }
  if (won) {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--win">
        WIN
      </span>
    )
  }
  if (lost) {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--loss">
        LOSS
      </span>
    )
  }
  // Completed but undecided (disputed/voided/no-side-won). Neutral pill.
  return (
    <span className="player-profile__result-chip player-profile__result-chip--pending">
      {status.toUpperCase()}
    </span>
  )
}

function formatDate(iso: string): string {
  // The server emits ISO timestamps with TZ; rendering in local time is
  // fine here since the column shows just month + day. (No bare YYYY-MM-DD
  // strings — that's the pattern that bit us before.)
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
}

type PageToken = number | 'ellipsis'

function paginationRange(current: number, total: number): PageToken[] {
  const delta = 1
  const range: PageToken[] = []
  const left = Math.max(2, current - delta)
  const right = Math.min(total - 1, current + delta)
  range.push(1)
  if (left > 2) range.push('ellipsis')
  for (let i = left; i <= right; i++) range.push(i)
  if (right < total - 1) range.push('ellipsis')
  if (total > 1) range.push(total)
  return range
}

function PaginationFooter({
  page,
  setPage,
  total,
  pageSize,
}: {
  page: number
  setPage: (n: number) => void
  total: number
  pageSize: number
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  const tokens = paginationRange(page, totalPages)
  const atFirst = page <= 1
  const atLast = page >= totalPages

  return (
    <div className="footer">
      <div className="footer-info">
        Showing <span className="mono">{first}–{last}</span> of{' '}
        <span className="mono">{total}</span> matches
      </div>
      <div className="footer-spacer" />
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={atFirst}
              onClick={() => setPage(1)}
              aria-label="First page"
            >
              <ChevronsLeft size={14} strokeWidth={2.4} />
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={atFirst}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} strokeWidth={2.4} />
            </Button>
          </PaginationItem>
          {tokens.map((t, i) =>
            t === 'ellipsis' ? (
              <PaginationItem key={i}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={i}>
                <PaginationLink
                  href="#"
                  isActive={t === page}
                  onClick={(e) => {
                    e.preventDefault()
                    setPage(t)
                  }}
                >
                  {t}
                </PaginationLink>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={atLast}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={14} strokeWidth={2.4} />
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={atLast}
              onClick={() => setPage(totalPages)}
              aria-label="Last page"
            >
              <ChevronsRight size={14} strokeWidth={2.4} />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
