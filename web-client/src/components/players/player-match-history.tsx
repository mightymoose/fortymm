import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import {
  usePlayerMatches,
  type PlayerDetail,
  type PlayerMatchRow,
} from '@/api/players'
import { PaginationFooter } from '@/components/pagination-footer'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/ui/user-avatar'

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
      {/* No count chip beside the title: the footer's "Showing 1–2 of 2
       * matches" readout is the page's single count (#1006). Two of them meant
       * the same number twice, and neither sibling list (the players list, the
       * matches list) carries one. */}
      <div className="player-profile__section-header">
        <span className="player-profile__section-title">Matches</span>
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
                <MatchRowComponent key={m.id} m={m} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* Shown at every *non-zero* row count. This used to be gated on
       * `total > PAGE_SIZE` — a history of a page or less rendered no count and
       * no pager at all, so a two-match history was a bare table with nothing
       * under it (#1006). That guard is gone for good: the footer self-clamps
       * (`safePage`, `first = total === 0 ? 0 : …`) and disables its own buttons
       * at a single page, so a short history needs no guard from us.
       *
       * `total > 0` is a different claim, not that guard coming back. At zero,
       * `MatchesEmpty` above already says "No matches yet"; a footer reading
       * "Showing 0–0 of 0 matches" over four dead buttons would only restate it
       * and offer a pager with nothing to page. An empty history is a designed
       * data state — the empty state is the whole of it. */}
      {total > 0 && (
        <PaginationFooter
          page={page}
          setPage={onPageChange}
          total={total}
          pageSize={PAGE_SIZE}
          totalPages={totalPages}
          noun="matches"
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

function MatchRowComponent({ m }: { m: PlayerMatchRow }) {
  // Solo matches carry a player-less sentinel side — the row renders it as an
  // italic "No opponent" rather than dropping the match (ADR-0008).
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
          {/* `UserAvatar` already paints the sentinel placeholder for a null
           * name, so the no-opponent case needs no branch of its own — it is
           * the same call. (`username` is optional on the wire; `?? null`
           * narrows it to the prop's `string | null`.) */}
          <UserAvatar name={m.opponent.username ?? null} size={26} />
          <span
            className="player-name"
            style={
              isNoOpp
                ? { color: 'var(--fg-3)', fontStyle: 'italic' }
                : undefined
            }
          >
            {opponentName}
          </span>
        </div>
      </td>
      <td>
        {m.games.length === 0 ? (
          <span
            style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}
          >
            —
          </span>
        ) : (
          <div className="player-profile__games">
            {m.games.map((g, i) => {
              const gameWon = g.mine > g.theirs
              return (
                <div
                  key={i}
                  className={
                    'player-profile__game ' +
                    (gameWon
                      ? 'player-profile__game--won'
                      : 'player-profile__game--lost')
                  }
                >
                  <span className="player-profile__game-mine">{g.mine}</span>
                  <span className="player-profile__game-theirs">
                    {g.theirs}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </td>
      <td>
        <ResultChip
          status={m.status}
          awaitingAcceptance={m.awaiting_acceptance}
          won={won}
          lost={lost}
        />
      </td>
    </tr>
  )
}

function ResultChip({
  status,
  awaitingAcceptance,
  won,
  lost,
}: {
  status: PlayerMatchRow['status']
  awaitingAcceptance: boolean
  won: boolean
  lost: boolean
}) {
  // A posted-but-unaccepted result and a genuinely-live match both sit at
  // `in_progress`; check the awaiting flag first so the former gets its own
  // "AWAITING" chip instead of the green "LIVE" one (#364). Mirrors the
  // matches list's "Awaiting" bucket.
  if (awaitingAcceptance) {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--awaiting">
        AWAITING
      </span>
    )
  }
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
  // Completed but undecided (voided/no-side-won). Neutral pill.
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
