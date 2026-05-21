import { useCallback, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  MoreHorizontal,
  Search,
  X,
} from 'lucide-react'

import { toast } from 'sonner'
import {
  fetchAllMatches,
  scoringNewRoute,
  useMatchList,
  type MatchListRow,
  type MatchStatus,
} from '@/api/matches'
import type { components } from '@/api/schema'
import { useSession } from '@/api/session'
import { AppShell } from '@/components/app-shell'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { matchesToCsv, downloadCsv } from '@/lib/matches-csv'
import { pageTitle } from '@/lib/page-title'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn, initialsOf } from '@/lib/utils'
import './index.css'

type MatchListRowSide = components['schemas']['MatchDetailsSide']

export const Route = createFileRoute('/matches/')({
  head: () => ({
    meta: [{ title: pageTitle('Matches') }],
  }),
  component: MatchesPage,
})

type RowTab = 'scheduled' | 'live' | 'final'
type StatusKey = RowTab

const TAB_TO_API: Record<RowTab, MatchStatus> = {
  scheduled: 'pending',
  live: 'in_progress',
  final: 'completed',
}
// Terminal statuses (disputed, voided) fall back to the `final` tone — they
// share final's "no further action" semantics, not scheduled's pending one.
const API_TO_TAB: Record<MatchStatus, RowTab> = {
  pending: 'scheduled',
  in_progress: 'live',
  completed: 'final',
  disputed: 'final',
  voided: 'final',
}

const STATUS_TABS: { value: 'all' | StatusKey; label: string; live?: boolean }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live', live: true },
  { value: 'scheduled', label: 'Up next' },
  { value: 'final', label: 'Final' },
]

const PAGE_SIZE = 25

const STATUS_TONE: Record<RowTab, string> = {
  live: 'status-tone-live',
  final: 'status-tone-final',
  scheduled: 'status-tone-scheduled',
}

type NavigateFn = ReturnType<typeof useNavigate>

function MatchesPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | StatusKey>('all')
  const [page, setPage] = useState(1)
  const debouncedQ = useDebouncedValue(q, 300).trim()
  const navigate = useNavigate()

  const apiStatus = status === 'all' ? undefined : TAB_TO_API[status]
  // Memoize the params bag so React Query's structural sharing — and any
  // future React.memo on MatchTable — sees a stable reference.
  const queryParams = useMemo(
    () => ({
      status: apiStatus,
      q: debouncedQ || undefined,
      page,
      page_size: PAGE_SIZE,
    }),
    [apiStatus, debouncedQ, page],
  )
  // Wait for the session before firing the matches query — otherwise a
  // first-visit direct-load races the session cookie and 401s into the error
  // boundary (#144). A disabled query stays `isPending`, so the skeleton holds
  // until the session resolves rather than flashing the empty state.
  const session = useSession()
  const matchList = useMatchList(queryParams, { enabled: session.isSuccess })
  const data = matchList.data
  const isLoading = matchList.isPending

  const changeStatus = useCallback((next: 'all' | StatusKey) => {
    setStatus(next)
    setPage(1)
  }, [])
  const changeQuery = useCallback((next: string) => {
    setQ(next)
    setPage(1)
  }, [])
  const onClear = useCallback(() => {
    setQ('')
    setStatus('all')
    setPage(1)
  }, [])

  const [exporting, setExporting] = useState(false)
  const onExport = useCallback(() => {
    setExporting(true)
    // Export the whole filtered set (every page), not just the visible one.
    fetchAllMatches({ status: apiStatus, q: debouncedQ || undefined })
      .then((rows) => {
        const stamp = new Date().toISOString().slice(0, 10)
        downloadCsv(`fortymm-matches-${stamp}.csv`, matchesToCsv(rows))
      })
      .catch(() => toast.error('Could not export matches. Try again.'))
      .finally(() => setExporting(false))
  }, [apiStatus, debouncedQ])

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const liveCount = data?.status_counts?.in_progress ?? 0

  return (
    <AppShell>
      <div className="match-list-page">
        <ActionBar
          liveCount={liveCount}
          onExport={onExport}
          exporting={exporting}
        />
        <FilterRow
          q={q}
          setQ={changeQuery}
          status={status}
          setStatus={changeStatus}
          statusCounts={data?.status_counts}
        />
        <div className="table-wrap">
          <MatchTable
            rows={items}
            isLoading={isLoading}
            onClear={onClear}
            navigate={navigate}
          />
        </div>
        <PaginationFooter
          page={page}
          setPage={setPage}
          total={total}
          pageSize={PAGE_SIZE}
        />
      </div>
    </AppShell>
  )
}

function ActionBar({
  liveCount,
  onExport,
  exporting,
}: {
  liveCount: number
  onExport: () => void
  exporting: boolean
}) {
  return (
    <div className="action-bar">
      <div className="action-bar-title">Matches</div>
      <div className="action-bar-crumb">
        Across tournaments, club nights, ladder &amp; casual
      </div>
      <span className="live-pill">
        <span className="live-dot" />
        {liveCount} LIVE
      </span>
      <div className="filter-spacer" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        disabled={exporting}
      >
        {exporting ? 'Exporting…' : 'Export CSV'}
      </Button>
      <Button asChild variant="default" size="sm">
        <Link to="/matches/new">+ New match</Link>
      </Button>
    </div>
  )
}

function FilterRow({
  q,
  setQ,
  status,
  setStatus,
  statusCounts,
}: {
  q: string
  setQ: (v: string) => void
  status: 'all' | StatusKey
  setStatus: (v: 'all' | StatusKey) => void
  statusCounts?: Record<string, number>
}) {
  function tabCount(value: 'all' | StatusKey): number | null {
    if (!statusCounts) return null
    if (value === 'all') {
      return Object.values(statusCounts).reduce((a, b) => a + b, 0)
    }
    return statusCounts[TAB_TO_API[value]] ?? 0
  }
  return (
    <div className="filter-row">
      <div className="ml-search">
        <Search className="ml-search-icon" size={16} strokeWidth={2} />
        <Input
          className="h-9 pl-9 pr-9"
          placeholder="Search players…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button
            type="button"
            className="ml-search-clear"
            onClick={() => setQ('')}
            aria-label="Clear search"
          >
            <X size={12} strokeWidth={2.4} />
          </button>
        )}
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => setStatus(v as 'all' | StatusKey)}
      >
        <TabsList>
          {STATUS_TABS.map((t) => {
            const count = tabCount(t.value)
            return (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="gap-1.5"
              >
                {t.live && <span className="live-dot" />}
                {t.label}
                {count !== null && <span className="seg-count">{count}</span>}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>
    </div>
  )
}

function MatchTable({
  rows,
  isLoading,
  onClear,
  navigate,
}: {
  rows: MatchListRow[]
  isLoading: boolean
  onClear: () => void
  navigate: NavigateFn
}) {
  if (isLoading && rows.length === 0) return <SkeletonRows />
  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Inbox size={56} strokeWidth={1.5} />
        </div>
        <div className="empty-title">No matches yet</div>
        <div className="empty-sub">
          Start a new match or clear the filters to see your history.
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="empty-clear"
          onClick={onClear}
        >
          Clear filters
        </Button>
      </div>
    )
  }
  return (
    <table className="matches">
      <MatchTableHead />
      <tbody>
        {rows.map((row) => (
          <MatchRow key={row.id} row={row} navigate={navigate} />
        ))}
      </tbody>
    </table>
  )
}

function MatchTableHead() {
  return (
    <thead>
      <tr>
        <th style={{ width: 120 }}>Match</th>
        <th>Players</th>
        <th style={{ width: 120 }}>Score</th>
        <th style={{ width: 120 }}>Status</th>
        <th style={{ width: 140 }}>Started</th>
        <th style={{ width: 56 }} />
      </tr>
    </thead>
  )
}

function SkeletonRows() {
  return (
    <table className="matches" aria-busy="true">
      <MatchTableHead />
      <tbody>
        {Array.from({ length: 6 }).map((_, i) => (
          <tr key={i} className="skeleton-row" aria-hidden="true">
            <td colSpan={6}>
              <div className="skeleton-line" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MatchRow({
  row,
  navigate,
}: {
  row: MatchListRow
  navigate: NavigateFn
}) {
  const tab = API_TO_TAB[row.status]
  const side1 = row.sides.find((s) => s.side_number === 1) ?? row.sides[0]
  const side2 = row.sides.find((s) => s.side_number === 2) ?? null
  const showScore =
    row.status === 'in_progress' || row.status === 'completed'

  function open() {
    void navigate({ to: '/matches/$matchId', params: { matchId: row.id } })
  }

  return (
    <tr
      className={cn('is-clickable', row.status === 'in_progress' && 'is-live')}
      role="link"
      tabIndex={0}
      aria-label={`Open match: ${sideLabel(side1)} vs ${sideLabel(side2)}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <td className="id-cell">M-{shortId(row.id)}</td>
      <td>
        <div className="players-cell">
          <PlayerChip side={side1} />
          <span className="players-vs">vs</span>
          <PlayerChip side={side2} />
        </div>
      </td>
      <td>
        <ScoreCell side1={side1} side2={side2} showScore={showScore} />
      </td>
      <td>
        <StatusBadge tab={tab} label={row.status_label} />
      </td>
      <td>
        <TimeCell iso={row.created_at} />
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {row.current_game_id ? (
          <Button asChild variant="default" size="sm">
            <Link {...scoringNewRoute(row.id, row.current_game_id)}>
              Score
            </Link>
          </Button>
        ) : (
          <button
            type="button"
            className="row-action"
            aria-label="Row actions"
          >
            <MoreHorizontal size={16} strokeWidth={2} />
          </button>
        )}
      </td>
    </tr>
  )
}

function sideLabel(side: MatchListRowSide | null): string {
  return side?.players.map((p) => p.username).join(' & ') || 'No opponent'
}

function PlayerChip({ side }: { side: MatchListRowSide | null }) {
  const name = sideLabel(side)
  const isEmpty = side === null
  return (
    <div className="player">
      <Avatar className="size-[26px]">
        <AvatarFallback className="font-mono text-[11px] font-bold">
          {isEmpty ? '?' : initialsOf(name)}
        </AvatarFallback>
      </Avatar>
      <span
        className={cn(
          'player-name',
          isEmpty && 'is-empty',
          side?.won === true && 'is-winner',
        )}
      >
        {name}
      </span>
    </div>
  )
}

function ScoreCell({
  side1,
  side2,
  showScore,
}: {
  side1: MatchListRowSide
  side2: MatchListRowSide | null
  showScore: boolean
}) {
  if (!showScore || side2 === null) {
    return <span className="score-cell pending">—</span>
  }
  return (
    <span className="score-cell games">
      {side1.games_won}–{side2.games_won}
    </span>
  )
}

function StatusBadge({ tab, label }: { tab: RowTab; label: string }) {
  return (
    <Badge variant="secondary" className={`status-pill ${STATUS_TONE[tab]}`}>
      {tab === 'live' && <span className="live-dot" />}
      {label}
    </Badge>
  )
}

function TimeCell({ iso }: { iso: string }) {
  const created = new Date(iso)
  const now = new Date()
  const days = Math.floor((now.getTime() - created.getTime()) / 86400000)
  let when: string
  if (days === 0) {
    const hh = String(created.getHours()).padStart(2, '0')
    const mm = String(created.getMinutes()).padStart(2, '0')
    when = `${hh}:${mm}`
  } else if (days === 1) when = 'yesterday'
  else if (days < 30) when = `${days}d ago`
  else when = created.toLocaleDateString()
  return (
    <span className="time-cell">
      <span className="strong">{when}</span>
    </span>
  )
}

function shortId(id: string): string {
  return id.slice(-6).toUpperCase().padStart(6, '0')
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
