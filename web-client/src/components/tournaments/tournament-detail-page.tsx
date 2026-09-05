import { useState } from 'react'
import { Calendar, Layers, MapPin, Table2, Trophy, Users } from 'lucide-react'

import { LocationMap } from '@/components/maps/location-map'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import {
  daysBetween,
  EM_DASH,
  emptyEvent,
  fmtDateRange,
  fmtVenueLine,
  genId,
} from './data/helpers'
import {
  NEW_EVENT_PARAM,
  type EventEditorSearch,
} from './data/event-editor-search'
import { lifecycleEdgeFor } from './data/lifecycle'
import type {
  EditedEvent,
  Tournament,
  TournamentEvent,
  TournamentTable,
  TournamentTableEntry,
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
  /** This tournament's table catalogue (for the Tables tab and reservations editor). */
  allTables: TournamentTable[]
  /** Persist the Details tab's draft. **The returned promise is load-bearing**
   * (#1593): `DetailsTab` awaits it, keeps the draft and its Save affordance over
   * a rejection, and reports every failure inline — so a rejection must reach it
   * rather than being swallowed by a toast. */
  onUpdate: (tournament: Tournament) => Promise<void>
  /** While the Details write is pending, its form is the only failure reporter.
   * The back breadcrumb is therefore withheld so it cannot unmount that form
   * before the awaited refusal is rendered inline (#1593). */
  savingDetails?: boolean
  /** Persist an edited table catalogue (add/remove from the Tables tab) as the
   * server's id-keyed diff (ADR 20260801). **The returned promise is load-bearing**:
   * `TablesTab` awaits it and turns the 409 on removing an in-use table into a
   * confirm, so a rejection must reach it rather than being swallowed by a toast. */
  onChangeCatalogue: (
    entries: TournamentTableEntry[],
    options: { unplaceFixturesOnRemovedTables: boolean },
  ) => Promise<void>
  /** Persist a new event. **The returned promise is load-bearing**: the `EventEditor`
   * awaits it, closes itself only when it RESOLVES, and stays open over a rejection —
   * so a refused create is reported instead of quietly binning everything the
   * organizer typed (#933, #934). */
  onCreateEvent: (event: EditedEvent) => Promise<void>
  /** Persist an edited event — same contract as `onCreateEvent`. */
  onUpdateEvent: (event: EditedEvent) => Promise<void>
  onDeleteEvent: (eventId: string) => void
  /** Whether the create/update event mutation is still in flight — passed straight to
   * the `EventEditor`, which disables its one submit control on it. Owned by the route,
   * because the route owns the mutations; this page only carries it across. See
   * `EventEditor`'s `saving` prop for why `isSubmitting` alone was not enough (#1231). */
  savingEvent?: boolean
  onBack: () => void
  /** Which event's editor the URL says is open — a uuid, the `new` sentinel, or
   * `undefined` for none. Already parsed at the route boundary
   * (`data/event-editor-search`); resolving it to an event of THIS tournament is
   * this page's job, because this is the first place that holds one. */
  openEditorFor?: EventEditorSearch
  /** Open an event's editor — a navigation that pushes exactly one history entry, so
   * one Back press dismisses the sheet (#1503). */
  onOpenEditor: (eventKey: string) => void
  /** Close it. `force` skips the discard confirmation, for the two closes that are
   * not a discard: a save has just persisted the work, and a delete raises a
   * confirmation of its own that must not be stacked on. */
  onCloseEditor: (options?: { force?: boolean }) => void
}

/**
 * Resolve `?event=` against a tournament. Pure, and called ONCE per value of the
 * param — see `useOpenEditorEvent` for why that matters.
 */
function resolveEditorEvent(
  openEditorFor: EventEditorSearch,
  tournament: Tournament,
  canEdit: boolean,
): TournamentEvent | null {
  if (openEditorFor === undefined) return null
  // `new` is an editor over an event that does not exist yet — not a state a reader
  // has. A viewer's `?event=new` is as meaningless as an unknown uuid, and closes the
  // same way (ADR-0015: read-only is a view, and there is nothing here to view).
  if (openEditorFor === NEW_EVENT_PARAM) return canEdit ? emptyEvent(tournament) : null
  // A well-formed uuid naming no event on THIS tournament is a URL that names no
  // resource: the editor stays closed, and nothing is requested (ADR-1001).
  return tournament.events.find((e) => e.id === openEditorFor) ?? null
}

/**
 * The event whose editor is open, resolved from the URL — and then **held**.
 *
 * Held, because `EventEditor` re-seeds its form whenever this object's IDENTITY
 * changes, and the tournament refetches in the background (every event mutation
 * invalidates it, and the realtime feed does too). Re-resolving against
 * `tournament.events` on every render would hand the editor an equal-but-new object
 * after any such refetch, and reset the form under the director's hands.
 *
 * So the resolution is redone only when the PARAM changes — the URL is the one thing
 * that decides which editor is open, and therefore the one thing that may re-seed it.
 * `emptyEvent` is held for the same reason twice over: it mints a fresh object on
 * every call, so re-running it would loop the editor's own re-seed effect.
 *
 * Held in state adjusted during render, not in a ref, because it is state the render
 * reads (https://react.dev/learn/you-might-not-need-an-effect).
 */
function useOpenEditorEvent(
  openEditorFor: EventEditorSearch,
  tournament: Tournament,
  canEdit: boolean,
): TournamentEvent | null {
  const [held, setHeld] = useState(() => ({
    openEditorFor,
    event: resolveEditorEvent(openEditorFor, tournament, canEdit),
  }))

  if (held.openEditorFor === openEditorFor) return held.event

  const event = resolveEditorEvent(openEditorFor, tournament, canEdit)
  setHeld({ openEditorFor, event })
  return event
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
  savingDetails = false,
  onChangeCatalogue,
  onCreateEvent,
  onUpdateEvent,
  onDeleteEvent,
  savingEvent = false,
  onBack,
  openEditorFor,
  onOpenEditor,
  onCloseEditor,
}: TournamentDetailPageProps) => {
  const [tab, setTab] = useState('events')
  const [pendingDelete, setPendingDelete] = useState<TournamentEvent | null>(null)

  const tournamentTables = tournament.tableIds
    .map((id) => allTables.find((t) => t.id === id))
    .filter((t): t is TournamentTable => t !== undefined)

  const canEdit = tournament.canEdit
  // The draw formats this server can run, as it sent them (ADR 20260726), for the
  // surfaces that do NOT get the tournament itself. `EventEditor` takes an `event`, not
  // a tournament, so the catalogue has to be threaded to it — and the "no catalogue"
  // case is decided here, where the payload lands: `null` means the tournament reached
  // this page without one (the list route withholds it; a never-fetched draft has
  // none), so the editor is handed an empty catalogue rather than a nullable one and
  // offers no draw type instead of re-deciding the same thing. The Events tab is handed
  // the whole `tournament` and reads the catalogue off it — one fact, one prop.
  const drawTypes = tournament.drawTypes ?? []
  // Server-derived, never re-computed here (#1511) — `null` iff the tournament
  // holds no events yet.
  const range = tournament.dateRange
  const days = daysBetween(range?.start, range?.end)
  const entries = tournament.events.reduce((s, e) => s + (e.entered || 0), 0)
  const reservations = tournament.events.reduce(
    (s, e) => s + e.reservations.length,
    0,
  )
  // `null` when the tournament has NO VENUE at all — a first-class state
  // (CONTEXT.md, "Venue"), and the reason the map below is gated on the address
  // itself and not only on the line: there are no coordinates to pin.
  const address = tournament.address
  // Empty for a null address, and empty when venue, city, and region are all blank
  // — and then the meta item is not rendered at all, pin included. Punctuation with
  // nothing to punctuate ("· ,") is a rendering bug, not a placeholder (#994); and
  // "Venue TBD" would be worse than either, since no venue is not a promise of one
  // (#1206).
  const venue = fmtVenueLine(address)

  const editorEvent = useOpenEditorEvent(openEditorFor, tournament, canEdit)
  // Radix keeps the sheet mounted through its slide-out, so blanking the event the
  // instant the URL drops the param would empty the panel mid-animation. Hold the
  // last one open. Adjusted during render rather than in an effect — the render
  // already knows (https://react.dev/learn/you-might-not-need-an-effect), the same
  // way `EventEditor` tracks the event it last seeded from.
  const [shownEvent, setShownEvent] = useState<TournamentEvent | null>(editorEvent)
  if (editorEvent && editorEvent !== shownEvent) setShownEvent(editorEvent)

  const openEvent = (ev: TournamentEvent) => onOpenEditor(ev.id)
  const openNewEvent = () => onOpenEditor(NEW_EVENT_PARAM)
  /** Persist the editor's draft — and **do not close anything here**.
   *
   * The promise is returned rather than swallowed, and the rejection is deliberately
   * NOT caught: the `EventEditor` awaits this, closes itself on the success path
   * alone, and catches the refusal — because it owns the sheet that must stay open
   * and the work that must survive. Firing the mutation and closing regardless (what
   * this used to do) is how a 422 became an event that was never created, reported
   * nowhere (#933, #934). */
  const saveEvent = (ev: EditedEvent) =>
    ev.id.startsWith('new')
      ? onCreateEvent({ ...ev, id: genId('ev') })
      : onUpdateEvent(ev)

  /** The open sheet's event's CURRENT `lock_version` (#1499) — read live off THIS
   * render's `tournament` prop, never off `editorEvent`. `useOpenEditorEvent` resolves
   * `?event=` once per value of the param and then HOLDS the result (#1503), so
   * `editorEvent` is frozen at the version the sheet opened on: a refetch that
   * reconciles the tournament does not reach back in and replace it — so reusing it
   * here would hand the editor's override the SAME stale version its conflict was just
   * refused for, and the override would conflict forever. `null` when this event no longer
   * appears on the reconciled tournament at all — another writer deleted it while the
   * sheet sat open, and there is no live version left to overwrite. */
  const currentLockVersion =
    tournament.events.find((e) => e.id === editorEvent?.id)?.lockVersion ?? null

  return (
    <div>
      <div className="mx-auto w-full max-w-[1320px] px-12 pt-11 pb-6">
        <PageHeading
          breadcrumb={[
            {
              label: 'Tournaments',
              onClick: savingDetails ? undefined : onBack,
            },
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
            {range ? (
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
              {/* WRAPS — it does not truncate, and it must not clamp (#1199).
                  A venue name is one free-text component the *read* shape leaves
                  unbounded on purpose (`api/app/schemas/tournament.py`: the bound
                  goes on the way in only, so historical rows still serialize), so
                  the page has to survive one that is already 680 characters long.
                  Hiding it is the wrong answer twice over — the organizer's own
                  venue is what the reader came for, and an ellipsis would not have
                  stopped the overflow anyway.

                  `wrap-anywhere` (overflow-wrap: anywhere), not `break-words`:
                  this span is a FLEX ITEM, and only `anywhere` shrinks the item's
                  **min-content contribution** down to one character.
                  `overflow-wrap: break-word` leaves min-content at the width of
                  the whole unbroken word — the item then refuses to shrink, paints
                  straight out of the header and takes the document with it.
                  Measured against the 680-character fixture: the span lays out
                  5236px wide and `html` reports a 3146px scroll width inside a
                  1280px viewport. `min-w-0` says
                  the same thing through the other mechanism (flex items default to
                  `min-width: auto`); both, because the two are cheap and the failure
                  is invisible in jsdom, which performs no layout. */}
              {/* Its own test id, separate from the meta item's: the overflow
                  assertions have to measure the TEXT box, not the row that
                  contains an icon as well. */}
              <span
                data-testid="tournament-venue-text"
                className="min-w-0 wrap-anywhere text-[color:var(--fg-1)]"
              >
                {venue}
              </span>
            </MetaItem>
          )}
        </div>

        {/* Display-only venue map at the tournament's server-geocoded coordinates
            (a stored `Address` carries non-null lat/lng). Gated on the ADDRESS as
            well as on the venue line: a tournament with no venue has no coordinates
            to pin, and a map at (0, 0) would put a private home game in the Gulf of
            Guinea. Keyless (dev/CI/e2e) it degrades to a text fallback of the venue
            line. */}
        {address && venue && (
          <LocationMap
            latitude={address.latitude}
            longitude={address.longitude}
            label={venue}
            className="mb-5 h-44 max-w-md"
          />
        )}

        {/* Below xl (1280px) the row loses a column at a time rather than shrinking
            every tile in place — the established breakpoint-ladder pattern (see
            `event-editor/basics-section.tsx`, `events-tab/event-card.tsx`). Without
            it, `grid-cols-5` forces five columns down to a phone, and `HeroStat`'s
            `Card` (`overflow-hidden`) computes an automatic minimum width of 0 for
            an item whose own overflow is not `visible` — so the tile happily
            shrinks past its content's minimum instead of forcing the row to scroll,
            and the number/label are cropped to nothing while staying in the
            accessibility tree (#1536). The container caps at `max-w-[1320px]`, and
            `xl` (1280px) already renders five across below that cap, so no custom
            breakpoint is needed to hold the five-across row at 1320px and up. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          <HeroStat label="Events" value={tournament.events.length} icon={<Trophy size={16} />} />
          <HeroStat label="Entries" value={entries} icon={<Users size={16} />} />
          <HeroStat label="Tables" value={tournament.tableIds.length} icon={<Table2 size={16} />} />
          <HeroStat
            label="Reservations"
            value={reservations}
            icon={<Layers size={16} />}
          />
          <HeroStat
            label="Days"
            value={range ? days : EM_DASH}
            suffix={range ? (days === 1 ? 'day' : 'days') : undefined}
            icon={<Calendar size={16} />}
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="border-b border-[color:var(--border-subtle)]">
          <div className="mx-auto w-full max-w-[1320px] px-12">
            <TabsList
              variant="line"
              className="h-auto p-0 [&_[data-slot=tabs-trigger]]:after:bg-[color:var(--ball-500)]"
            >
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
          {/* forceMount + self-managed `hidden`: the Details form stays mounted
              across tab switches. Radix unmounts every other panel when it goes
              inactive, so a save still in flight when the organizer moved to
              Events/Tables/Schedule used to have its rejection written into a
              form that was already gone — and returning to Details mounted a
              fresh, silent one (#1593 review). Mounted, the report waits beside
              the draft it preserved: the alert, any field error, and Save are
              all there when Details comes back. Radix's forceMount hides
              nothing itself (`hidden: !present` is always false here), so the
              inactive panel is hidden with the attribute — display:none via
              preflight in a browser, and out of the accessibility tree (role
              queries included) everywhere.

              That hiding is also why the tab gets `active`: a refusal landing
              under another tab cannot take focus (nothing in display:none can),
              and the unchanged error never re-fires — so the tab re-focuses the
              retained refusal on this edge, the moment the panel is back
              (#1593 review). */}
          <TabsContent
            value="details"
            forceMount
            hidden={tab !== 'details'}
          >
            <DetailsTab
              tournament={tournament}
              canEdit={canEdit}
              active={tab === 'details'}
              onUpdate={onUpdate}
            />
          </TabsContent>
        </div>
      </Tabs>

      <EventEditor
        open={editorEvent !== null}
        onClose={onCloseEditor}
        event={shownEvent}
        currentLockVersion={currentLockVersion}
        tables={tournamentTables}
        drawTypes={drawTypes}
        canEdit={canEdit}
        saving={savingEvent}
        onSave={saveEvent}
        onDelete={(id) => {
          const ev = tournament.events.find((e) => e.id === id) ?? null
          // `force`: the delete confirmation is about to open, and stacking "Discard
          // changes?" in front of it would ask the director to protect edits they
          // have just asked to delete the event holding. The existing sharp edge
          // this leaves is unchanged — cancelling the delete does not bring the
          // editor back — but it is not made worse.
          onCloseEditor({ force: true })
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
