import { useState } from 'react'
import {
  Calendar,
  Hash,
  Layers,
  MapPin,
  Radio,
  Rocket,
  Square,
  Table2,
  Trophy,
  Users,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import {
  daysBetween,
  effectiveDateRange,
  emptyEvent,
  fmtDateRange,
  genId,
} from './data/helpers'
import type {
  Tournament,
  TournamentEvent,
  TournamentTable,
} from './data/types'
import { PageHeading } from './page-heading'
import { StatusBadge } from './status-badge'
import { DetailsTab } from './tournament-detail-page/details-tab'
import { EventEditor } from './tournament-detail-page/event-editor'
import { EventsTab } from './tournament-detail-page/events-tab'
import { HeroStat } from './tournament-detail-page/hero-stat'
import { ScheduleTab } from './tournament-detail-page/schedule-tab'
import { TablesTab } from './tournament-detail-page/tables-tab'

export interface TournamentDetailPageProps {
  tournament: Tournament
  /** This tournament's table catalogue (for the Tables tab and pool editor). */
  allTables: TournamentTable[]
  onUpdate: (tournament: Tournament) => void
  /** Persist an edited table catalogue (add/remove from the Tables tab). */
  onChangeCatalogue: (catalogue: TournamentTable[]) => void
  onCreateEvent: (event: TournamentEvent) => void
  onUpdateEvent: (event: TournamentEvent) => void
  onDeleteEvent: (eventId: string) => void
  onBack: () => void
}

function MetaItem({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-[14px] text-[color:var(--fg-2)]">
      <span className="text-[color:var(--fg-3)]">{icon}</span>
      {children}
    </span>
  )
}

/** The tournament detail page: hero header with status lifecycle actions, a
 * meta strip, a five-up stat strip, and the Events / Tables / Schedule /
 * Details tabs, plus the slide-in event editor. */
export const TournamentDetailPage = ({
  tournament,
  allTables,
  onUpdate,
  onChangeCatalogue,
  onCreateEvent,
  onUpdateEvent,
  onDeleteEvent,
  onBack,
}: TournamentDetailPageProps) => {
  const [tab, setTab] = useState('events')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorEvent, setEditorEvent] = useState<TournamentEvent | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TournamentEvent | null>(null)

  const tournamentTables = tournament.tableIds
    .map((id) => allTables.find((t) => t.id === id))
    .filter((t): t is TournamentTable => t !== undefined)

  const range = effectiveDateRange(tournament)
  const entries = tournament.events.reduce((s, e) => s + (e.entered || 0), 0)
  const pools = tournament.events.reduce((s, e) => s + e.pools.length, 0)

  const openEvent = (ev: TournamentEvent) => {
    setEditorEvent(ev)
    setEditorOpen(true)
  }
  const openNewEvent = () => {
    setEditorEvent(emptyEvent(tournament))
    setEditorOpen(true)
  }
  const saveEvent = (ev: TournamentEvent) => {
    if (ev.id.startsWith('new')) onCreateEvent({ ...ev, id: genId('ev') })
    else onUpdateEvent(ev)
    setEditorOpen(false)
  }

  return (
    <div>
      <div className="mx-auto w-full max-w-[1320px] px-12 pt-11 pb-6">
        <PageHeading
          breadcrumb={[
            { label: 'Tournaments', onClick: onBack },
            { label: tournament.name },
          ]}
          title={tournament.name}
          action={
            <div className="flex items-center gap-2">
              {tournament.status === 'draft' && (
                <Button
                  onClick={() => onUpdate({ ...tournament, status: 'published' })}
                >
                  <Rocket size={16} />
                  Publish
                </Button>
              )}
              {tournament.status === 'published' && (
                <Button
                  className="border border-[color:rgba(0,226,154,0.35)] bg-[color:rgba(0,226,154,0.1)] text-[color:var(--serve-500)] hover:bg-[color:rgba(0,226,154,0.18)]"
                  onClick={() => onUpdate({ ...tournament, status: 'live' })}
                >
                  <Radio size={16} />
                  Start tournament
                </Button>
              )}
              {tournament.status === 'live' && (
                <Button
                  variant="ghost"
                  onClick={() => onUpdate({ ...tournament, status: 'archived' })}
                >
                  <Square size={16} />
                  End tournament
                </Button>
              )}
            </div>
          }
        />

        <div className="mb-5 flex flex-wrap items-center gap-6">
          <StatusBadge status={tournament.status} />
          <MetaItem icon={<Calendar size={14} />}>
            {range.start ? (
              <span className="font-mono tabular-nums text-[color:var(--fg-1)]">
                {fmtDateRange(range.start, range.end)}
              </span>
            ) : (
              <span className="text-[color:var(--fg-3)] italic">
                Dates set by events — add one to begin.
              </span>
            )}
          </MetaItem>
          <MetaItem icon={<MapPin size={14} />}>
            <span className="text-[color:var(--fg-1)]">
              {tournament.address.venue}
            </span>
            <span className="mx-1.5 text-[color:var(--fg-3)]">·</span>
            <span>
              {tournament.address.city}, {tournament.address.region}
            </span>
          </MetaItem>
          <MetaItem icon={<Hash size={14} />}>
            <span className="font-mono text-[12px] text-[color:var(--fg-3)]">
              {tournament.id}
            </span>
          </MetaItem>
        </div>

        <div className="grid grid-cols-5 gap-3">
          <HeroStat label="Events" value={tournament.events.length} icon={<Trophy size={16} />} />
          <HeroStat label="Entries" value={entries} icon={<Users size={16} />} />
          <HeroStat label="Tables" value={tournament.tableIds.length} icon={<Table2 size={16} />} />
          <HeroStat label="Pools" value={pools} icon={<Layers size={16} />} />
          <HeroStat
            label="Days"
            value={range.start ? daysBetween(range.start, range.end) : '—'}
            suffix={range.start ? 'days' : undefined}
            icon={<Calendar size={16} />}
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="border-b border-[color:var(--border-subtle)]">
          <div className="mx-auto w-full max-w-[1320px] px-12">
            <TabsList className="h-auto gap-1 bg-transparent p-0">
              <TabsTrigger value="events">
                Events
                <span className="ml-1.5 rounded-full bg-[color:var(--bg-card)] px-1.5 font-mono text-[11px] tabular-nums">
                  {tournament.events.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="tables">
                Tables
                <span className="ml-1.5 rounded-full bg-[color:var(--bg-card)] px-1.5 font-mono text-[11px] tabular-nums">
                  {tournament.tableIds.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="schedule">Schedule</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <div className="mx-auto w-full max-w-[1320px] px-12 pt-7 pb-20">
          <TabsContent value="events">
            <EventsTab
              tournament={tournament}
              onOpenEvent={openEvent}
              onNewEvent={openNewEvent}
            />
          </TabsContent>
          <TabsContent value="tables">
            <TablesTab
              tournament={tournament}
              catalogue={allTables}
              onChangeCatalogue={onChangeCatalogue}
            />
          </TabsContent>
          <TabsContent value="schedule">
            <ScheduleTab tournament={tournament} />
          </TabsContent>
          <TabsContent value="details">
            <DetailsTab tournament={tournament} onUpdate={onUpdate} />
          </TabsContent>
        </div>
      </Tabs>

      <EventEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        event={editorEvent}
        tables={tournamentTables}
        onSave={saveEvent}
        onDelete={(id) => {
          const ev = tournament.events.find((e) => e.id === id) ?? null
          setEditorOpen(false)
          setPendingDelete(ev)
        }}
      />

      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        kind="event"
        name={pendingDelete?.name}
        onConfirm={() => {
          if (pendingDelete) onDeleteEvent(pendingDelete.id)
          setPendingDelete(null)
        }}
      />
    </div>
  )
}
