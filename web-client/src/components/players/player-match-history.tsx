import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'

import { usePlayerMatches, type PlayerDetail } from '@/api/players'
import { Button } from '@/components/ui/button'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination'

import { MatchHistoryRow } from './player-match-history/match-history-row'

// The table, chips and footer are styled by the profile's stylesheet, scoped
// under the shared `.player-profile` root class this surface also wears.
import './player-profile.css'
import './player-match-history.css'

/** Mirrors the backend's `LIST_DEFAULT_PAGE_SIZE` for
 * `GET /v1/players/{id}/matches` (`api/app/players.py`). */
const PAGE_SIZE = 25

/**
 * The player's **full** match history — the paginated surface behind
 * `/players/$userId/matches`.
 *
 * Per ADR-0008 this list is deliberately all-inclusive: every match the player
 * is a side of, any status, rated or not — live, up-next, awaiting-acceptance,
 * voided, and the player-less "No opponent" solo sentinel. Do not narrow it to
 * rated or completed play; that reconciliation was considered and rejected.
 *
 * The route owns the page number (it lives in the URL) and the player identity
 * (read from the profile bundle, usually a cache hit when the user arrived from
 * the profile).
 */
export interface PlayerMatchHistoryProps {
  /** Route path param — known before the profile bundle resolves, so the back
   * link works during the pending window. */
  playerId: string
  /** The loaded player (for the heading), or null while the profile query is
   * pending. */
  player: PlayerDetail | null
  isPending: boolean
  /** 1-based page. Owned by the route so pagination state lives in the URL. */
  page: number
  onPageChange: (next: number) => void
}

export function PlayerMatchHistory({
  playerId,
  player,
  isPending,
  page,
  onPageChange,
}: PlayerMatchHistoryProps) {
  return (
    // `--pane` is the fixed-height viewport the table scrolls inside, under a
    // pinned pagination footer. The profile used to supply it via the shared
    // `.player-profile` class; it is a normal scrolling document now, so this
    // page asks for the pane explicitly.
    <div className="player-profile player-profile--pane dark fortymm-theme">
      <HistoryHeader
        playerId={playerId}
        player={player}
        isPending={isPending}
      />
      <div className="player-profile__body">
        {player ? (
          <PlayerMatchesSection
            playerId={player.id}
            page={page}
            onPageChange={onPageChange}
          />
        ) : (
          // The matches query is gated behind the (session-gated) profile
          // query, so hold a skeleton rather than an empty pane while the
          // player resolves.
          <section className="player-profile__section">
            <div className="player-profile__section-header">
              <span className="player-profile__section-title">Matches</span>
            </div>
            <div className="player-profile__table-wrap">
              <MatchesSkeleton />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function HistoryHeader({
  playerId,
  player,
  isPending,
}: {
  playerId: string
  player: PlayerDetail | null
  isPending: boolean
}) {
  return (
    <header className="player-history__header">
      <Link
        to="/players/$userId"
        params={{ userId: playerId }}
        className="player-history__back"
      >
        <ArrowLeft size={14} strokeWidth={2.4} aria-hidden="true" />
        Back to profile
      </Link>
      {isPending || player === null ? (
        <div
          className="player-history__title-skeleton"
          aria-busy="true"
          aria-label="Loading player"
        />
      ) : (
        <h1 className="player-history__title">
          <span className="player-history__title-name">{player.username}</span>
          <span className="player-history__title-sep" aria-hidden="true">
            ·
          </span>
          <span className="player-history__title-label">Match history</span>
        </h1>
      )}
    </header>
  )
}

/**
 * The paginated, all-inclusive matches table + its footer.
 *
 * Local to this surface: the profile shows a six-row "Recent matches" card
 * projected off its bundle and links here for the rest, so this page is the
 * table's only consumer.
 */
function PlayerMatchesSection({
  playerId,
  page,
  onPageChange,
}: {
  playerId: string
  page: number
  onPageChange: (next: number) => void
}) {
  // No `initialData` seeding from the profile bundle: that bundle now carries
  // only the six most recent matches (`page_size: 6`), so seeding it into this
  // 25-per-page cache slot would paint six rows under a "Showing 1–25 of N"
  // footer and — being stamped fresh — never refetch. Page 1 fetches for real.
  const { data, isPending, isFetching, isError, refetch } = usePlayerMatches(
    playerId,
    { page, page_size: PAGE_SIZE },
  )
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isOutOfRange = page > totalPages

  // Snap an out-of-range `?page=` back to the last valid page once the real
  // total is known — a stale bookmark or deep-link past the end would
  // otherwise fetch an empty page and render the "No matches yet" empty state
  // under a nonsensical "Showing 24951–28 of 28" footer (#637, same defect as
  // #541 on the /matches list). Only act on a settled, current total:
  // `isPending` covers the initial/session-gated window (where `total` is
  // still 0), and `isFetching` covers a `keepPreviousData` refetch still
  // serving the prior page's total.
  useEffect(() => {
    if (!isPending && !isFetching && isOutOfRange) {
      onPageChange(totalPages)
    }
  }, [isPending, isFetching, isOutOfRange, totalPages, onPageChange])

  return (
    <section className="player-profile__section">
      <div className="player-profile__section-header">
        <span className="player-profile__section-title">Matches</span>
        {data && <span className="player-profile__section-count">{total}</span>}
      </div>
      <div className="player-profile__table-wrap">
        {isError ? (
          <MatchesError onRetry={() => void refetch()} />
        ) : isPending || (rows.length === 0 && (isOutOfRange || isFetching)) ? (
          // Hold the skeleton — rather than flashing the cold "No matches yet"
          // — across the whole out-of-range redirect, not just its first
          // frame. After the effect snaps `?page=999` back to the last page,
          // `keepPreviousData` keeps serving the empty out-of-range payload
          // (so `isOutOfRange` is already false) while the valid page
          // refetches; gating the empty-rows case on `isFetching` too covers
          // that window.
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
                <MatchHistoryRow key={m.id} match={m} />
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
  // Clamp a stale/out-of-range `page` to a valid one so the range math can
  // never render start > end — e.g. the frame before the parent's redirect
  // effect snaps a deep-linked `?page=999` back to the last page (#637). The
  // footer is self-protecting regardless of what the caller passes.
  const safePage = Math.min(Math.max(1, page), totalPages)
  const first = total === 0 ? 0 : (safePage - 1) * pageSize + 1
  const last = Math.min(total, safePage * pageSize)
  const tokens = paginationRange(safePage, totalPages)
  const atFirst = safePage <= 1
  const atLast = safePage >= totalPages

  return (
    <div className="footer">
      <div className="footer-info">
        Showing{' '}
        <span className="mono">
          {first}–{last}
        </span>{' '}
        of <span className="mono">{total}</span> matches
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
              onClick={() => setPage(safePage - 1)}
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
                  isActive={t === safePage}
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
              onClick={() => setPage(safePage + 1)}
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
