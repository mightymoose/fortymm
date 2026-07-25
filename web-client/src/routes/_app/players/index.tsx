import { useCallback, useEffect } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { Search, X } from 'lucide-react'
import { z } from 'zod'

import {
  playerListQueryOptions,
  usePlayerList,
  type PlayerSummary,
} from '@/api/players'
import { SESSION_QUERY_KEY, useSession } from '@/api/session'
import { PaginationFooter } from '@/components/pagination-footer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UserAvatar } from '@/components/ui/user-avatar'
import { pageTitle } from '@/lib/page-title'
import { useDebouncedValue } from '@/lib/use-debounced-value'

// Reuse the matches list's scaffold (action bar, filter row, table chrome,
// footer) so both pages stay visually identical — only the per-row cells
// differ. Player-specific cell styles live in players-cells.css.
import '@/components/matches/match-list/match-list.css'
import '@/components/players/players-cells.css'

// URL is the source of truth for filters + pagination so refresh / share / back
// keeps the spot. `.optional().catch(undefined)` keeps junk values from
// throwing — they silently fall back to defaults.
const playersSearchSchema = z.object({
  q: z.string().trim().min(1).optional().catch(undefined),
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

const PAGE_SIZE = 25

export const Route = createFileRoute('/_app/players/')({
  head: () => ({
    meta: [{ title: pageTitle('Players') }],
  }),
  validateSearch: zodValidator(playersSearchSchema),
  // The filter + page live in the URL, so the prefetched list must be keyed by
  // them — expose the search to the loader.
  loaderDeps: ({ search }) => search,
  // Warm the React Query cache without blocking the route transition, so an
  // intent preload makes the click render instantly. Skip the prefetch on a
  // cold direct load where the session isn't resolved yet — firing here would
  // 401 into the error boundary ahead of the component's session-gated query
  // (same pattern as `/matches`). The query key matches the component's first
  // render: `useDebouncedValue` seeds its initial value synchronously, so the
  // debounced `q` equals the URL `q` on mount.
  loader: ({ context, deps }) => {
    if (!context.queryClient.getQueryData(SESSION_QUERY_KEY)) return
    void context.queryClient.prefetchQuery(
      playerListQueryOptions({
        q: deps.q?.trim() || undefined,
        page: deps.page ?? 1,
        page_size: PAGE_SIZE,
      }),
    )
  },
  component: PlayersPage,
  errorComponent: PlayersListError,
})

function PlayersPage() {
  const search = Route.useSearch()
  const q = search.q ?? ''
  const page = search.page ?? 1
  const navigate = useNavigate()

  // Debounce only the data fetch — URL updates synchronously so refresh /
  // share / back stay accurate. Mirrors the pattern in `/matches`.
  const debouncedQ = useDebouncedValue(q.trim(), 300)

  const session = useSession()
  const list = usePlayerList(
    { q: debouncedQ || undefined, page, page_size: PAGE_SIZE },
    // Gate on the session so a first-visit direct-load doesn't race the
    // session cookie and 401 into the error boundary.
    { enabled: session.isSuccess },
  )
  const data = list.data
  const isLoading = list.isPending
  const isFetching = list.isFetching
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

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

  // Snap an out-of-range `?page=` back to the last valid page once the real
  // total is known — a stale bookmark or paging past the end would otherwise
  // render an empty roster under a nonsensical "Showing 51–40 of 40" footer
  // (#373). Only act on a settled, current total: `isLoading` covers the
  // pending/session-gated window (total still 0), and `isFetching` covers a
  // `keepPreviousData` refetch still serving the prior filter's total. Mirrors
  // the matches list clamp.
  useEffect(() => {
    if (!isLoading && !isFetching && page > totalPages) {
      setPage(totalPages)
    }
  }, [isLoading, isFetching, page, totalPages, setPage])

  // The redirect runs in an effect, so an out-of-range page paints for one
  // frame first. Clamp the page the footer renders with so the range math
  // never shows start > end during that frame.
  const displayPage = Math.min(page, totalPages)

  return (
    <div className="match-list-page">
      <ActionBar total={total} />
      <FilterRow q={q} setQ={setQ} />
      <div className="table-wrap">
        <PlayerTable
          rows={items}
          isLoading={isLoading}
          onClear={onClear}
        />
      </div>
      <PaginationFooter
        page={displayPage}
        setPage={setPage}
        total={total}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        noun={{ one: 'player', other: 'players' }}
      />
    </div>
  )
}

function ActionBar({ total }: { total: number }) {
  return (
    <div className="action-bar">
      <div className="action-bar-title">Players</div>
      <div className="action-bar-crumb">
        Tournament roster &amp; ratings
      </div>
      {total > 0 && (
        <span className="seg-count" style={{ marginLeft: 8 }}>
          {total}
        </span>
      )}
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
          placeholder="Search by username…"
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
  isLoading,
  onClear,
}: {
  rows: PlayerSummary[]
  isLoading: boolean
  onClear: () => void
}) {
  if (isLoading && rows.length === 0) {
    return <SkeletonRows />
  }
  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">No players match</div>
        <div className="empty-sub">Try a different username.</div>
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

function SkeletonRows() {
  return (
    <table className="matches" aria-busy="true">
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
        {Array.from({ length: 8 }).map((_, i) => (
          <tr key={i} className="skeleton-row" aria-hidden="true">
            <td colSpan={5}>
              <div className="skeleton-line" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PlayerRow({ player }: { player: PlayerSummary }) {
  const navigate = useNavigate()
  const open = () =>
    navigate({ to: '/players/$userId', params: { userId: player.id } })
  return (
    <tr
      className="is-clickable"
      role="link"
      tabIndex={0}
      aria-label={`Open ${player.username} profile`}
      onClick={() => void open()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void open()
        }
      }}
    >
      {/* Below 640px the shared match-list stylesheet hides the thead and paints
       * each row as a card, re-adding the column name only for cells that opt in
       * via `data-label` (#900). Without it the stat values sat there bare — a
       * lone "1500" with nothing saying it's a rating. The label copy must match
       * the <th> text above so the mobile caption and the desktop column agree.
       * The name/seed cells take the same headline/caption hooks the matches row
       * uses (`data-cell="players"` / `.id-cell`) instead of a stat label. */}
      <td className="id-cell">
        <SeedCell rank={player.rank} />
      </td>
      <td data-cell="players">
        <div className="player">
          <UserAvatar name={player.username} size={32} />
          <span className="player-name">{player.username}</span>
        </div>
      </td>
      <td data-label="Rating">
        <RatingCell rating={player.rating} />
      </td>
      <td data-label="W–L">
        <span className="players-record">
          {player.wins}
          <span className="players-record-loss"> – {player.losses}</span>
        </span>
      </td>
      <td data-label="Form · L5">
        <FormDots form={player.form} />
      </td>
    </tr>
  )
}

function SeedCell({ rank }: { rank: number | null | undefined }) {
  // `rank` is the player's true global rating rank (1 = highest); `null` /
  // undefined means unrated — render a dim em-dash, like the rating/form cells,
  // rather than a number. Guard the null explicitly: in JS `null <= 4` is
  // `true`, so a bare `rank <= 4` would gild every unrated player gold (#841).
  if (rank === null || rank === undefined) {
    return (
      <span className="players-seed" style={{ color: 'var(--fg-3)' }}>
        —
      </span>
    )
  }
  return (
    <span className={'players-seed' + (rank <= 4 ? ' players-seed--top' : '')}>
      #{rank}
    </span>
  )
}

function RatingCell({ rating }: { rating: number | null | undefined }) {
  // `null` / undefined rating === player hasn't played a rated match yet;
  // render a dim em-dash so the column still aligns instead of collapsing.
  if (rating === null || rating === undefined) {
    return (
      <span
        className="players-rating"
        style={{ color: 'var(--fg-3)', fontWeight: 500 }}
      >
        —
      </span>
    )
  }
  return <span className="players-rating">{Math.round(rating)}</span>
}

/** How many of the wire's results this column shows. `form` is a *shared*
 * field — it rides on `PlayerSummary`, which the profile bundle also
 * serializes — and the API sends TEN results, because the profile is where a
 * player is studied in depth (`FORM_WINDOW`, api/app/players.py). The roster's
 * column is a glance, not a study: it shows the five most recent (they arrive
 * newest-first) and the header reads "Form · L5". Widen the wire, slice here. */
const ROSTER_FORM_DOTS = 5

function FormDots({ form }: { form: string }) {
  // Players with no completed matches yet get an empty form string; the
  // column reads as a dash rather than a row of empty boxes.
  if (form.length === 0) {
    return (
      <span
        className="players-form"
        style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}
      >
        —
      </span>
    )
  }
  const shown = form.slice(0, ROSTER_FORM_DOTS)
  return (
    <span
      className="players-form"
      // Name what is actually on screen: a player with three decided matches
      // shows three dots, so the label must say "Last 3", not "Last 5".
      aria-label={`Last ${shown.length}: ${shown.split('').join(' ')}`}
    >
      {shown.split('').map((c, i) => (
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

/** Route-level error boundary fallback — the list query is `throwOnError`,
 * so any non-2xx response or network failure flows here. Keeps the shell
 * around so the user can navigate away. */
function PlayersListError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter()
  return (
    <div role="alert" className="empty">
      <div className="empty-title">Couldn’t load players</div>
      <div className="empty-sub">
        Something went wrong reaching the server.
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="empty-clear"
        onClick={() => {
          reset()
          router.invalidate()
        }}
      >
        Try again
      </Button>
    </div>
  )
}

