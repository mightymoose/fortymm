import { useCallback, useMemo } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  X,
} from 'lucide-react'
import { z } from 'zod'

import { AppShell } from '@/components/app-shell'
import {
  COUNTRIES,
  PLAYERS,
  type Player,
} from '@/components/players/players-data'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination'
import { UserAvatar } from '@/components/ui/user-avatar'
import { pageTitle } from '@/lib/page-title'

// Reuse the matches list's scaffold (action bar, filter row, table chrome,
// footer) so both pages stay visually identical — only the per-row cells
// differ. Player-specific cell styles live in players-cells.css.
import '@/routes/matches/index.css'
import '@/components/players/players-cells.css'

// URL is the source of truth for filters + pagination so refresh / share / back
// keeps the spot. `.optional().catch(undefined)` keeps junk values from
// throwing — they silently fall back to defaults.
const playersSearchSchema = z.object({
  q: z.string().trim().min(1).optional().catch(undefined),
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

export const Route = createFileRoute('/players/')({
  head: () => ({
    meta: [{ title: pageTitle('Players') }],
  }),
  validateSearch: zodValidator(playersSearchSchema),
  component: PlayersPage,
})

const PAGE_SIZE = 25

function PlayersPage() {
  const search = Route.useSearch()
  const q = search.q ?? ''
  const page = search.page ?? 1
  const navigate = useNavigate()

  const filtered = useMemo(() => {
    const list = PLAYERS.slice().sort((a, b) => b.rating - a.rating)
    if (!q) return list
    const qq = q.toLowerCase()
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(qq) ||
        p.club.toLowerCase().includes(qq) ||
        // Match both the ISO code ("VN") and the human-readable name
        // ("Vietnam") so typing the country in either form works.
        p.country.toLowerCase().includes(qq) ||
        COUNTRIES[p.country].name.toLowerCase().includes(qq),
    )
  }, [q])

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const cur = Math.min(page, totalPages)
  const start = (cur - 1) * PAGE_SIZE
  const visible = filtered.slice(start, start + PAGE_SIZE)

  // Rewrite the URL — `replace: true` keeps each keystroke from filling
  // browser history. Defaults are stripped so the URL stays clean.
  const setSearch = useCallback(
    (patch: Partial<z.infer<typeof playersSearchSchema>>) => {
      void navigate({
        to: '/players',
        replace: true,
        search: (prev) => {
          const merged = { ...prev, ...patch }
          return {
            q: merged.q && merged.q.length > 0 ? merged.q : undefined,
            page: merged.page && merged.page > 1 ? merged.page : undefined,
          }
        },
      })
    },
    [navigate],
  )

  const setQ = useCallback(
    (next: string) => setSearch({ q: next || undefined, page: undefined }),
    [setSearch],
  )
  const setPage = useCallback((n: number) => setSearch({ page: n }), [setSearch])
  const onClear = useCallback(
    () => setSearch({ q: undefined, page: undefined }),
    [setSearch],
  )

  const liveCount = PLAYERS.filter((p) => p.status === 'live').length

  return (
    <AppShell>
      <div className="match-list-page">
        <ActionBar liveCount={liveCount} />
        <FilterRow q={q} setQ={setQ} />
        <div className="table-wrap">
          <PlayerTable rows={visible} onClear={onClear} />
        </div>
        <PaginationFooter
          page={cur}
          setPage={setPage}
          total={total}
          pageSize={PAGE_SIZE}
        />
      </div>
    </AppShell>
  )
}

function ActionBar({ liveCount }: { liveCount: number }) {
  return (
    <div className="action-bar">
      <div className="action-bar-title">Players</div>
      <div className="action-bar-crumb">
        Tournament roster &amp; ratings
      </div>
      <span className="live-pill">
        <span className="live-dot" />
        {liveCount} LIVE
      </span>
      <div className="filter-spacer" />
    </div>
  )
}

function FilterRow({
  q,
  setQ,
}: {
  q: string
  setQ: (v: string) => void
}) {
  return (
    <div className="filter-row">
      <div className="ml-search">
        <Search className="ml-search-icon" size={16} strokeWidth={2} />
        <Input
          className="h-9 pl-9 pr-9"
          placeholder="Search by name, club, country…"
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
    </div>
  )
}

function PlayerTable({
  rows,
  onClear,
}: {
  rows: Player[]
  onClear: () => void
}) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">No players match</div>
        <div className="empty-sub">
          Try a different name, club, or country code.
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="empty-clear"
          onClick={onClear}
        >
          Clear search
        </Button>
      </div>
    )
  }
  return (
    <table className="matches">
      <thead>
        <tr>
          <th style={{ width: 64 }}>Seed</th>
          <th>Player</th>
          <th style={{ width: 90 }}>Rating</th>
          <th style={{ width: 80 }}>W–L</th>
          <th style={{ width: 100 }}>Form · L5</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <PlayerRow key={p.id} player={p} />
        ))}
      </tbody>
    </table>
  )
}

function PlayerRow({ player }: { player: Player }) {
  const navigate = useNavigate()
  const open = () =>
    navigate({ to: '/players/$userId', params: { userId: player.id } })
  return (
    <tr
      className="is-clickable"
      role="link"
      tabIndex={0}
      aria-label={`Open ${player.name} profile`}
      onClick={() => void open()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void open()
        }
      }}
    >
      <td>
        <span
          className={
            'players-seed' + (player.seed <= 4 ? ' players-seed--top' : '')
          }
        >
          #{player.seed}
        </span>
      </td>
      <td>
        <div className="player">
          <UserAvatar name={player.name} size={32} />
          <span className="player-name">{player.name}</span>
        </div>
      </td>
      <td>
        <span className="players-rating">{player.rating}</span>
      </td>
      <td>
        <span className="players-record">
          {player.w}
          <span className="players-record-loss"> – {player.l}</span>
        </span>
      </td>
      <td>
        <FormDots form={player.form} />
      </td>
    </tr>
  )
}

function FormDots({ form }: { form: string }) {
  return (
    <span
      className="players-form"
      aria-label={`Last 5: ${form.split('').join(' ')}`}
    >
      {form.split('').map((c, i) => (
        <span
          key={i}
          className={
            'players-form-dot ' +
            (c === 'W' ? 'players-form-dot--w' : 'players-form-dot--l')
          }
        >
          {c}
        </span>
      ))}
    </span>
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
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  const tokens = paginationRange(page, totalPages)
  const atFirst = page <= 1
  const atLast = page >= totalPages

  return (
    <div className="footer">
      <div className="footer-info">
        Showing <span className="mono">{first}–{last}</span> of{' '}
        <span className="mono">{total}</span> players
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
