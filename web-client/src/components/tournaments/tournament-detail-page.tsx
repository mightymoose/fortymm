import { useState } from 'react'
import { Calendar, Layers, MapPin, Table2, Trophy, Users } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import {
  daysBetween,
  effectiveDateRange,
  EM_DASH,
  emptyEvent,
  fmtDateRange,
  fmtVenueLine,
  genId,
} from './data/helpers'
import { lifecycleEdgeFor } from './data/lifecycle'
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
import { LifecycleActions } from './tournament-detail-page/lifecycle-actions'
import { ScheduleTab } from './tournament-detail-page/schedule-tab'
import { TablesTab } from './tournament-detail-page/tables-tab'

export interface TournamentDetailPageProps {
  tournament: Tournament
  /** This tournament's table catalogue (for the Tables tab and pool editor). */
  allTables: TournamentTable[]
  onUpdate: (tournament: Tournament) => void
  /** Persist an edited table catalogue (add/remove from the Tables tab). */
  onChangeCatalogue: (catalogue: TournamentTable[]) => void
  /** Persist a new event. **The returned promise is load-bearing**: the `EventEditor`
   * awaits it, closes itself only when it RESOLVES, and stays open over a rejection —
   * so a refused create is reported instead of quietly binning everything the
   * organizer typed (#933, #934). */
  onCreateEvent: (event: TournamentEvent) => Promise<void>
  /** Persist an edited event — same contract as `onCreateEvent`. */
  onUpdateEvent: (event: TournamentEvent) => Promise<void>
  onDeleteEvent: (eventId: string) => void
  onBack: () => void
}

function MetaItem({
  icon,
  testId,
  children,
}: {
  icon: React.ReactNode
  testId?: string
  children: React.ReactNode
}) {
  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-0 items-center gap-2 text-[14px] text-[color:var(--fg-2)]"
    >
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

  const canEdit = tournament.canEdit
  const range = effectiveDateRange(tournament)
  const days = daysBetween(range.start, range.end)
  const entries = tournament.events.reduce((s, e) => s + (e.entered || 0), 0)
  const pools = tournament.events.reduce((s, e) => s + e.pools.length, 0)
  // Empty when venue, city, and region are all blank — and then the meta item
  // is not rendered at all, pin included. Punctuation with nothing to punctuate
  // ("· ,") is a rendering bug, not a placeholder (#994).
  const venue = fmtVenueLine(tournament.address)

  const openEvent = (ev: TournamentEvent) => {
    setEditorEvent(ev)
    setEditorOpen(true)
  }
  const openNewEvent = () => {
    setEditorEvent(emptyEvent(tournament))
    setEditorOpen(true)
  }
  /** Persist the editor's draft — and **do not close anything here**.
   *
   * The promise is returned rather than swallowed, and the rejection is deliberately
   * NOT caught: the `EventEditor` awaits this, closes itself on the success path
   * alone, and catches the refusal — because it owns the sheet that must stay open
   * and the work that must survive. Firing the mutation and closing regardless (what
   * this used to do) is how a 422 became an event that was never created, reported
   * nowhere (#933, #934). */
  const saveEvent = (ev: TournamentEvent) =>
    ev.id.startsWith('new')
      ? onCreateEvent({ ...ev, id: genId('ev') })
      : onUpdateEvent(ev)

  return (
    <div>
      <div className="mx-auto w-full max-w-[1320px] px-12 pt-11 pb-6">
        <PageHeading
          breadcrumb={[
            { label: 'Tournaments', onClick: onBack },
            { label: tournament.name },
          ]}
          title={tournament.name}
          // The lifecycle affordance owns its own writes: it posts the edge to
          // `…/transitions` rather than routing a status through `onUpdate`, which
          // patches the tournament's *fields* and carries no status at all
          // (ADR-0017). `lifecycleEdgeFor` is the same accessor the component
          // renders from, so a viewer — and an archived tournament, which has no
          // edge out of it — leaves the action slot genuinely empty (a falsy
          // action: `PageHeading` wraps a truthy one in a spacing div) rather than
          // filling it with a wrapper around a component that renders nothing.
          action={
            lifecycleEdgeFor(tournament) && (
              <LifecycleActions tournament={tournament} />
            )
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
          {venue && (
            <MetaItem icon={<MapPin size={14} />} testId="tournament-venue-line">
              <span className="truncate text-[color:var(--fg-1)]">{venue}</span>
            </MetaItem>
          )}
        </div>

        <div className="grid grid-cols-5 gap-3">
          <HeroStat label="Events" value={tournament.events.length} icon={<Trophy size={16} />} />
          <HeroStat label="Entries" value={entries} icon={<Users size={16} />} />
          <HeroStat label="Tables" value={tournament.tableIds.length} icon={<Table2 size={16} />} />
          <HeroStat label="Pools" value={pools} icon={<Layers size={16} />} />
          <HeroStat
            label="Days"
            value={range.start ? days : EM_DASH}
            suffix={range.start ? (days === 1 ? 'day' : 'days') : undefined}
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
              canEdit={canEdit}
              onOpenEvent={openEvent}
              onNewEvent={openNewEvent}
            />
          </TabsContent>
          <TabsContent value="tables">
            <TablesTab
              tournament={tournament}
              catalogue={allTables}
              canEdit={canEdit}
              onChangeCatalogue={onChangeCatalogue}
            />
          </TabsContent>
          <TabsContent value="schedule">
            <ScheduleTab tournament={tournament} tables={allTables} />
          </TabsContent>
          <TabsContent value="details">
            <DetailsTab
              tournament={tournament}
              canEdit={canEdit}
              onUpdate={onUpdate}
            />
          </TabsContent>
        </div>
      </Tabs>

      <EventEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        event={editorEvent}
        tables={tournamentTables}
        canEdit={canEdit}
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
