import { useState } from 'react'
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

import {
  scoringNewRoute,
  useMatchList,
  type MatchListRow,
  type MatchStatus,
} from '@/api/matches'
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
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn } from '@/lib/utils'
import './index.css'

export const Route = createFileRoute('/matches/')({
  component: MatchesPage,
})

type StatusKey = 'live' | 'final' | 'called' | 'scheduled'

// UI tabs ↔ API status. `called` has no backend concept yet — the tab stays
// visible (disabled) so the navigation shape is stable as features land.
const TAB_TO_API: Record<Exclude<StatusKey, 'called'>, MatchStatus> = {
  scheduled: 'pending',
  live: 'in_progress',
  final: 'completed',
}
const API_TO_TAB: Record<MatchStatus, StatusKey | null> = {
  pending: 'scheduled',
  in_progress: 'live',
  completed: 'final',
  disputed: null,
  voided: null,
}

const STATUS_TABS: { value: 'all' | StatusKey; label: string; live?: boolean }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live', live: true },
  { value: 'called', label: 'Called' },
  { value: 'scheduled', label: 'Up next' },
  { value: 'final', label: 'Final' },
]

const PAGE_SIZE = 25

// Pill tones keyed by UI tab; the visible text comes from the API's
// `status_label` so the FE doesn't redefine copy.
const STATUS_TONE: Record<StatusKey, string> = {
  live: 'status-tone-live',
  final: 'status-tone-final',
  called: 'status-tone-called',
  scheduled: 'status-tone-scheduled',
}

function MatchesPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | StatusKey>('all')
  const [page, setPage] = useState(1)
  const debouncedQ = useDebouncedValue(q, 300).trim()

  const apiStatus = status === 'all' || status === 'called'
    ? undefined
    : TAB_TO_API[status]
  const { data, isLoading } = useMatchList({
    status: apiStatus,
    q: debouncedQ || undefined,
    page,
    page_size: PAGE_SIZE,
  })

  function changeStatus(next: 'all' | StatusKey) {
    setStatus(next)
    setPage(1)
  }
  function changeQuery(next: string) {
    setQ(next)
    setPage(1)
  }

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const liveCount = data?.status_counts?.in_progress ?? 0

  return (
    <AppShell>
      <TooltipProvider>
        <div className="match-list-page">
          <ActionBar liveCount={liveCount} />
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
              onClear={() => {
                changeQuery('')
                changeStatus('all')
              }}
            />
          </div>
          <PaginationFooter
            page={page}
            setPage={setPage}
            total={total}
            pageSize={PAGE_SIZE}
          />
        </div>
      </TooltipProvider>
    </AppShell>
  )
}

function ActionBar({ liveCount }: { liveCount: number }) {
  return (
    <div className="action-bar">
      <div className="action-bar-title">Matches</div>
      <div className="action-bar-crumb">
        Across tournaments, club nights, ladder &amp; casual
      </div>
      <span className="live-pill">
        <span className="live-dot" />
        {String(liveCount).padStart(2, '0')} LIVE
      </span>
      <div className="filter-spacer" />
      <Button variant="ghost" size="sm">
        Export CSV
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
    if (value === 'called') return null
    if (!statusCounts) return 0
    if (value === 'all') {
      // Backend total counts every status the user participates in, so derive
      // the "all" count from the same histogram the tabs render from.
      return Object.values(statusCounts).reduce((a, b) => a + b, 0)
    }
    const apiStatus = TAB_TO_API[value]
    return statusCounts[apiStatus] ?? 0
  }
  return (
    <div className="filter-row">
      <div className="ml-search">
        <Search className="ml-search-icon" size={16} strokeWidth={2} />
        <Input
          className="h-9 pl-9 pr-9"
          placeholder="Search opponents…"
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
            const disabled = t.value === 'called'
            return (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="gap-1.5"
                disabled={disabled}
              >
                {t.live && <span className="live-dot" />}
                {t.label}
                {count !== null && <span className="seg-count">{count}</span>}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>

      <div className="filter-spacer" />

      <ComingSoonSelect label="Context" placeholder="All contexts" />
      <ComingSoonSelect label="Round" placeholder="All rounds" />
      <ComingSoonSelect label="Court" placeholder="All courts" />
    </div>
  )
}

function ComingSoonSelect({
  label,
  placeholder,
}: {
  label: string
  placeholder: string
}) {
  return (
    <>
      <span className="filter-label">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Wrap the disabled trigger so the tooltip still receives hover. */}
          <span>
            <Select disabled>
              <SelectTrigger className="h-9 min-w-[120px]" disabled>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent />
            </Select>
          </span>
        </TooltipTrigger>
        <TooltipContent>coming soon</TooltipContent>
      </Tooltip>
    </>
  )
}

function MatchTable({
  rows,
  isLoading,
  onClear,
}: {
  rows: MatchListRow[]
  isLoading: boolean
  onClear: () => void
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
      <thead>
        <tr>
          <th style={{ width: 120 }}>Match</th>
          <th>Opponent</th>
          <th style={{ width: 120 }}>Score</th>
          <th style={{ width: 120 }}>Status</th>
          <th style={{ width: 140 }}>Started</th>
          <th style={{ width: 56 }} />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <MatchRow key={row.id} row={row} />
        ))}
      </tbody>
    </table>
  )
}

function SkeletonRows() {
  return (
    <table className="matches" aria-busy="true">
      <thead>
        <tr>
          <th style={{ width: 120 }}>Match</th>
          <th>Opponent</th>
          <th style={{ width: 120 }}>Score</th>
          <th style={{ width: 120 }}>Status</th>
          <th style={{ width: 140 }}>Started</th>
          <th style={{ width: 56 }} />
        </tr>
      </thead>
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

function MatchRow({ row }: { row: MatchListRow }) {
  const navigate = useNavigate()
  const tab = API_TO_TAB[row.status] ?? 'scheduled'
  const opponentName = row.opponent_username ?? 'No opponent'
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
      aria-label={`Open match against ${opponentName}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <td className="id-cell">M-{row.id.slice(-6).toUpperCase()}</td>
      <td>
        <div className="player">
          <Avatar className="size-[26px]">
            <AvatarFallback className="font-mono text-[11px] font-bold">
              {initials(opponentName)}
            </AvatarFallback>
          </Avatar>
          <span
            className={cn(
              'player-name',
              row.is_win === true && 'is-winner',
              row.is_win === false && 'is-loser',
            )}
          >
            {opponentName}
          </span>
        </div>
      </td>
      <td>
        <ScoreCell row={row} showScore={showScore} />
      </td>
      <td>
        <StatusBadge status={tab} label={row.status_label} />
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
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal size={16} strokeWidth={2} />
          </button>
        )}
      </td>
    </tr>
  )
}

function ScoreCell({
  row,
  showScore,
}: {
  row: MatchListRow
  showScore: boolean
}) {
  if (!showScore) return <span className="score-cell pending">—</span>
  return (
    <span className="score-cell games">
      {row.my_games_won}–{row.opponent_games_won}
    </span>
  )
}

function StatusBadge({ status, label }: { status: StatusKey; label: string }) {
  return (
    <Badge variant="secondary" className={`status-pill ${STATUS_TONE[status]}`}>
      {status === 'live' && <span className="live-dot" />}
      {label}
    </Badge>
  )
}

function TimeCell({ iso }: { iso: string }) {
  const created = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - created.getTime()
  const dayMs = 86400000
  const days = Math.floor(diffMs / dayMs)
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

function initials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const letters =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2)
  return letters.toUpperCase() || '?'
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
