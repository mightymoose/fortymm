import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Plus, Search, Trophy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import { EmptyState } from './empty-state'
import { NearMeControl } from './near-me-control'
import { NewTournamentModal } from './new-tournament-modal'
import {
  STATUS_FILTER_OPTIONS,
  parseStatusFilter,
  type StatusFilter,
} from './data/options'
import { tournamentsSearchSchema, type TournamentsSearch } from './data/search'
import type { TournamentsNearMe } from './data/api'
import type { Tournament } from './data/types'
import { PageHeading } from './page-heading'
import { TournamentCard } from './tournament-card'

export interface TournamentsListPageProps {
  tournaments: Tournament[]
  onOpen: (id: string) => void
  onCreate: (draft: Omit<Tournament, 'id'>) => void | Promise<void>
  onDelete: (id: string) => void
  /** Whether to surface the "New tournament" action — gated on the caller's
   * `tournament.create` permission. Creating 403s without it, so hide it. */
  canCreate: boolean
  /** The "Near me" filter changed: the resolved `{ lat, lng, radiusMiles }`
   * triple, or `undefined` when off/denied/unavailable. The route lifts this to
   * where the list query is called so the query re-runs — the filtering is
   * server-side, layered on top of the client-side name/status filters below. */
  onNearMeChange: (nearMe: TournamentsNearMe | undefined) => void
  /** Whether the "Near me" filter is currently narrowing the list.
   *
   * It has to be told, not derived: near me filters **server-side**, so it shrinks
   * `tournaments` itself rather than `filtered` below. Without this flag a near-me
   * filter that matches nothing is indistinguishable from owning no tournaments, and
   * a user with six tournaments fifty miles away gets told to create their first
   * (#970). The route passes `nearMe !== undefined`. */
  nearMeActive: boolean
}

/** The tournament-admin list: search + status filter, a responsive grid of
 * cards, the "New tournament" modal, and a delete confirmation.
 *
 * The status tab and the search text live in **the URL**, so a filtered list is
 * shareable and survives a reload. It reads them through `useSearch({ strict: false })`
 * rather than through the Route object, which keeps it from importing the route module
 * and closing a route → page → route cycle — the arrangement `MatchList` uses. */
export const TournamentsListPage = ({
  tournaments,
  onOpen,
  onCreate,
  onDelete,
  canCreate,
  onNearMeChange,
  nearMeActive,
}: TournamentsListPageProps) => {
  // `strict: false` reads the active location's validated search without binding to a
  // route id, so this renders under both the real route and a test harness.
  const urlSearch = useSearch({ strict: false }) as TournamentsSearch
  const navigate = useNavigate()

  const status: StatusFilter = urlSearch.status ?? 'all'

  // The search box holds its OWN raw text, seeded from the URL. It must not bind to
  // the parsed value: the schema's `.trim()` is a transform, not a check, so a bound
  // input drops the trailing space of "Bay " on every keystroke and a two-word search
  // becomes untypeable. The URL still gets every keystroke, below.
  const [queryText, setQueryText] = useState(urlSearch.q ?? '')

  // ...but a buffer that only ever seeds goes stale. The app shell's own sidebar entry
  // is `to: '/tournaments'` with no search, so clicking it while a search is active is
  // a SAME-ROUTE navigation: the URL drops `q` and this component never unmounts. The
  // box kept its text and the grid stayed filtered while the URL said otherwise — the
  // user asked for the unfiltered list and got the filtered one. Back does it too.
  //
  // So the buffer follows the URL when the URL changes underneath it. Written as the
  // render-time "adjust state when the thing it derives from changed" pattern, keyed on
  // the PREVIOUS url value, not on a mismatch: a mismatch is the normal mid-keystroke
  // state (the buffer leads the URL by a render), and resetting on it would eat the
  // character just typed. `!== queryText.trim()` then ignores the echo of our own
  // write, which is what keeps the trailing space of "Bay " alive.
  const [urlQueryEcho, setUrlQueryEcho] = useState(urlSearch.q)
  if (urlSearch.q !== urlQueryEcho) {
    setUrlQueryEcho(urlSearch.q)
    if ((urlSearch.q ?? '') !== queryText.trim()) setQueryText(urlSearch.q ?? '')
  }

  const [createOpen, setCreateOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Tournament | null>(null)

  // `replace: true` — a search is one intent, not one history entry per keystroke.
  // A default is written as `undefined` so it drops out of the URL entirely.
  const setSearch = useCallback(
    (patch: Partial<TournamentsSearch>) => {
      void navigate({
        to: '/tournaments',
        replace: true,
        // The write goes through the same schema as the read, so the URL can only ever
        // hold a value the page can parse back. Whitespace-only `q` collapses to
        // `undefined` here rather than persisting as a `?q=%20%20%20` the user can
        // neither see nor clear, and a default drops out of the URL entirely.
        //
        // `prev` is the router's union across every route's search params, so it is
        // deliberately not annotated — the parse is what narrows it.
        search: (prev) => tournamentsSearchSchema.parse({ ...prev, ...patch }),
      })
    },
    [navigate],
  )

  const changeStatus = useCallback(
    (raw: string) => {
      const next = parseStatusFilter(raw)
      setSearch({ status: next === 'all' ? undefined : next })
    },
    [setSearch],
  )

  const changeQuery = useCallback(
    (next: string) => {
      setQueryText(next)
      setSearch({ q: next || undefined })
    },
    [setSearch],
  )

  const query = queryText.trim()

  const filtered = useMemo(() => {
    // Lowercased once, not once per row: the needle does not change across the scan.
    const needle = query.toLowerCase()
    return tournaments.filter((t) => {
      if (status !== 'all' && t.status !== status) return false
      if (needle && !t.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [tournaments, status, query])

  // Only `live`, not `published || live`. The subtitle now names the status it counts,
  // so "3 total · 0 live" is a normal, correct reading of a board nobody has started.
  const liveCount = tournaments.filter((t) => t.status === 'live').length

  // Whether anything is narrowing the list — which of the two empty states to show.
  // Near me is in here because the server, not the client, removed those rows.
  const isFiltered = query.length > 0 || status !== 'all' || nearMeActive

  return (
    <div className="mx-auto w-full max-w-[1320px] px-12 pt-11 pb-20">
      <PageHeading
        breadcrumb={[{ label: 'Manage' }, { label: 'Tournaments' }]}
        title="Tournaments"
        subtitle={`${tournaments.length} total · ${liveCount} live. Create draws, book reservations, publish to players.`}
        action={
          canCreate ? (
            <Button size="lg" onClick={() => setCreateOpen(true)}>
              <Plus size={18} />
              New tournament
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-[320px]">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[color:var(--fg-3)]"
          />
          <Input
            aria-label="Search tournaments by name"
            value={queryText}
            placeholder="Search by name…"
            className="h-9 pl-9"
            onChange={(e) => changeQuery(e.target.value)}
          />
        </div>
        <Tabs value={status} onValueChange={changeStatus}>
          <TabsList>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <TabsTrigger key={o.value} value={o.value}>
                {o.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <NearMeControl onNearMeChange={onNearMeChange} />
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-[color:var(--fg-3)]">
          {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
        </span>
      </div>

      {filtered.length === 0 ? (
        /* Two different facts, two different messages. Telling a brand-new user with
           nothing on the board to "adjust the filters" names filters they never set
           (#970), so the copy branches on whether anything is actually narrowing. */
        <EmptyState
          icon={<Trophy size={28} />}
          title={isFiltered ? 'No tournaments match' : 'No tournaments yet'}
          hint={
            isFiltered
              ? 'Adjust the filters or create a new one.'
              : 'Tournaments will appear here once one is created.'
          }
          action={
            canCreate ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus size={16} />
                New tournament
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-3.5">
          {filtered.map((t) => (
            <TournamentCard
              key={t.id}
              tournament={t}
              onOpen={() => onOpen(t.id)}
              onDelete={() => setPendingDelete(t)}
            />
          ))}
        </div>
      )}

      {/* The modal owns its submit lifecycle: it awaits onCreate and closes
          itself (via onOpenChange) only on success, surfacing a failure inline
          instead of closing over it (#614). */}
      <NewTournamentModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={onCreate}
      />
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        kind="tournament"
        name={pendingDelete?.name}
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id)
          setPendingDelete(null)
        }}
      />
    </div>
  )
}
