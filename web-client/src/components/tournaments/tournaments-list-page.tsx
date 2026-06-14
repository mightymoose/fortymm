import { useMemo, useState } from 'react'
import { Plus, Search, Trophy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import { EmptyState } from './empty-state'
import { NewTournamentModal } from './new-tournament-modal'
import { STATUS_FILTER_OPTIONS } from './data/options'
import type { Tournament } from './data/types'
import { PageHeading } from './page-heading'
import { TournamentCard } from './tournament-card'

export interface TournamentsListPageProps {
  tournaments: Tournament[]
  onOpen: (id: string) => void
  onCreate: (draft: Omit<Tournament, 'id'>) => void
  onDelete: (id: string) => void
}

type StatusFilter = (typeof STATUS_FILTER_OPTIONS)[number]['value']

/** The tournament-admin list: search + status filter, a responsive grid of
 * cards, the "New tournament" modal, and a delete confirmation. */
export const TournamentsListPage = ({
  tournaments,
  onOpen,
  onCreate,
  onDelete,
}: TournamentsListPageProps) => {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Tournament | null>(null)

  const filtered = useMemo(
    () =>
      tournaments.filter((t) => {
        if (filter !== 'all' && t.status !== filter) return false
        if (query && !t.name.toLowerCase().includes(query.toLowerCase()))
          return false
        return true
      }),
    [tournaments, filter, query],
  )

  const activeCount = tournaments.filter(
    (t) => t.status === 'published' || t.status === 'live',
  ).length

  return (
    <div className="mx-auto w-full max-w-[1320px] px-12 pt-11 pb-20">
      <PageHeading
        breadcrumb={[{ label: 'Manage' }, { label: 'Tournaments' }]}
        title="Tournaments"
        subtitle={`${tournaments.length} total · ${activeCount} active. Create draws, schedule pools, publish to players.`}
        action={
          <Button size="lg" onClick={() => setCreateOpen(true)}>
            <Plus size={18} />
            New tournament
          </Button>
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
            value={query}
            placeholder="Search by name…"
            className="h-9 pl-9"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
          <TabsList>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <TabsTrigger key={o.value} value={o.value}>
                {o.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-[color:var(--fg-3)]">
          {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Trophy size={28} />}
          title="No tournaments match"
          hint="Adjust the filters or create a new one."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} />
              New tournament
            </Button>
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

      <NewTournamentModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(draft) => {
          onCreate(draft)
          setCreateOpen(false)
        }}
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
