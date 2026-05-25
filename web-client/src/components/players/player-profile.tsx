import { useMemo } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'

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
import {
  COUNTRIES,
  MATCHES,
  PLAYERS,
  type MatchRecord,
  type Player,
} from './players-data'

/**
 * Profile surface shared by the authed `/users/:userId` route and the public
 * `/p/users/:username` route. Renders the design's Bebas hero plus a single
 * matches list — no tabs.
 *
 * Data is hardcoded from the design fixture for now (see `players-data.ts`).
 * Once the backend has the right endpoints this swaps to live data without
 * changing the component's visual shape.
 */
export interface PlayerProfileProps {
  player: Player | null
  /** When false (the public route, for anonymous viewers) match rows render as
   * static panels instead of links — there's nothing under /matches/:id to
   * navigate to without a session. */
  matchesAreLinks?: boolean
  /** 1-based page for the matches list. Owned by the route so pagination
   * state lives in the URL. Defaults to 1. */
  page?: number
  onPageChange?: (next: number) => void
}

const PAGE_SIZE = 10

export function PlayerProfile({
  player,
  matchesAreLinks = true,
  page = 1,
  onPageChange,
}: PlayerProfileProps) {
  return (
    <div className="player-profile dark fortymm-theme">
      <Hero player={player} />
      <div className="player-profile__body">
        {player && (
          <MatchesSection
            asLinks={matchesAreLinks}
            page={page}
            onPageChange={onPageChange ?? (() => undefined)}
          />
        )}
      </div>
    </div>
  )
}

function Hero({ player }: { player: Player | null }) {
  if (!player) {
    return (
      <header className="player-profile__hero">
        <div className="player-profile__hero-row">
          <div className="player-profile__avatar-ring">
            <UserAvatar name="?" size={120} ring />
            <span
              aria-hidden="true"
              className="player-profile__avatar-dashed"
            />
          </div>
          <div className="player-profile__name-wrap">
            <div className="player-profile__overline">FortyMM Player</div>
            <h1 className="player-profile__name player-profile__name--loading">
              Loading…
            </h1>
          </div>
        </div>
      </header>
    )
  }
  const country = COUNTRIES[player.country]
  return (
    <header className="player-profile__hero">
      <div className="player-profile__hero-row">
        <div className="player-profile__avatar-ring">
          <UserAvatar name={player.name} size={120} ring />
          <span aria-hidden="true" className="player-profile__avatar-dashed" />
        </div>
        <div className="player-profile__name-wrap">
          <div className="player-profile__overline">FortyMM Player</div>
          <h1 className="player-profile__name">
            {player.name.toUpperCase()}
            <span className="player-profile__name-dot">.</span>
          </h1>
          <div className="player-profile__sub">
            <span className="player-profile__sub-flag" aria-hidden="true">
              {country.flag}
            </span>
            <span>{country.name}</span>
            <span className="player-profile__sub-sep" aria-hidden="true" />
            <span>{player.club}</span>
            <span className="player-profile__sub-sep" aria-hidden="true" />
            <span>{player.age} yrs</span>
            <span className="player-profile__sub-sep" aria-hidden="true" />
            <span className="player-profile__sub-handle">#{player.seed}</span>
          </div>
        </div>
        <div className="player-profile__hero-rating">
          <div className="player-profile__overline">FortyMM Rating</div>
          <div className="player-profile__hero-rating-chip">
            {player.rating}
          </div>
          <div className="player-profile__hero-rating-meta">
            Peak{' '}
            <span className="player-profile__hero-rating-meta-mono">
              {player.rating}
            </span>{' '}
            · Season high{' '}
            <span className="player-profile__hero-rating-meta-mono">
              {player.rating}
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}

function MatchesSection({
  asLinks,
  page,
  onPageChange,
}: {
  asLinks: boolean
  page: number
  onPageChange: (next: number) => void
}) {
  // The design seeded matches for one player (p01). For every other profile we
  // render the same list as a stand-in so the page never reads empty during
  // the hardcoded-fixture phase.
  const all = useMemo<MatchRecord[]>(() => MATCHES, [])
  const total = all.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const cur = Math.min(page, totalPages)
  const start = (cur - 1) * PAGE_SIZE
  const visible = all.slice(start, start + PAGE_SIZE)

  return (
    <section className="player-profile__section">
      <div className="player-profile__section-header">
        <span className="player-profile__section-title">Matches</span>
        <span className="player-profile__section-count">{total}</span>
      </div>
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
          {visible.map((m) => (
            <MatchRowComponent key={m.id} m={m} asLink={asLinks} />
          ))}
        </tbody>
      </table>
      {total > PAGE_SIZE && (
        <PaginationFooter
          page={cur}
          setPage={onPageChange}
          total={total}
          pageSize={PAGE_SIZE}
        />
      )}
    </section>
  )
}

function MatchRowComponent({
  m,
  asLink,
}: {
  m: MatchRecord
  asLink: boolean
}) {
  // Match-detail routes aren't wired up in the hardcoded-fixture phase, so
  // even when `asLink` is true the row renders as a static panel for now.
  void asLink
  const opponent = PLAYERS.find((p) => p.id === m.opp)
  const opponentName = opponent?.name ?? 'Unknown opponent'
  const won = m.result === 'W'
  return (
    <tr>
      <td>
        <span className="time-cell">
          <span className="strong">{formatDate(m.date)}</span>
        </span>
      </td>
      <td>
        <div className="player">
          <UserAvatar name={opponentName} size={26} />
          <span className="player-name">{opponentName}</span>
        </div>
      </td>
      <td>
        <div className="player-profile__sets">
          {m.sets.map((s, i) => {
            const setWon = s[0] > s[1]
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
                <span className="player-profile__set-mine">{s[0]}</span>
                <span className="player-profile__set-theirs">{s[1]}</span>
              </div>
            )
          })}
        </div>
      </td>
      <td>
        <span
          className={
            'player-profile__result-chip player-profile__result-chip--' +
            (won ? 'win' : 'loss')
          }
        >
          {won ? 'WIN' : 'LOSS'}
        </span>
      </td>
    </tr>
  )
}

// Parse YYYY-MM-DD as local-calendar components — bare `new Date('2026-05-23')`
// is interpreted as UTC midnight, so anyone west of UTC sees the prior day.
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
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
