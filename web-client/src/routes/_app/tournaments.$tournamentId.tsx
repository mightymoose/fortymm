import { useEffect, useRef } from 'react'
import {
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { TournamentDetailPage } from '@/components/tournaments/tournament-detail-page'
import { TournamentNotFound } from '@/components/tournaments/tournament-not-found'
import { TournamentRouteError } from '@/components/tournaments/tournament-route-error'
import {
  eventToCreateBody,
  eventToUpdateBody,
  tournamentToUpdateBody,
  useCreateEvent,
  useDeleteEvent,
  useTables,
  useTournament,
  useUpdateEvent,
  useUpdateTableCatalogue,
  useUpdateTournament,
} from '@/components/tournaments/data/api'
import { eventEditorSearchSchema } from '@/components/tournaments/data/event-editor-search'
import { pageTitle } from '@/lib/page-title'

/** The tournament id segment. The API types `tournament_id` as a `uuid.UUID`, so a
 * non-uuid segment is a URL that names no resource — never a request to make. */
const tournamentIdSchema = z.string().uuid()

export const Route = createFileRoute('/_app/tournaments/$tournamentId')({
  // Validate the id at the route boundary, BEFORE any fetch (ADR-1001). A non-uuid
  // segment (`new`, `abc`, `%20`) throws `notFound()` here, so it lands in
  // `notFoundComponent` below rather than hitting the API and leaking a Pydantic
  // "Input should be a valid UUID" string into the error boundary (#992, #1050,
  // #1090). A router-thrown `notFound` from `params.parse` is tagged with this
  // route's id, so it renders THIS route's `notFoundComponent`.
  params: {
    parse: (raw) => {
      const parsed = tournamentIdSchema.safeParse(raw.tournamentId)
      if (!parsed.success) throw notFound()
      return { tournamentId: parsed.data }
    },
  },
  // Which event's editor is open, parsed at the boundary beside the id above.
  validateSearch: zodValidator(eventEditorSearchSchema),
  head: () => ({
    meta: [{ title: pageTitle('Tournament') }],
  }),
  component: TournamentDetailRoute,
  // The two boundaries, and the split between them is the whole of ADR-1001.
  // `notFoundComponent` owns the one status that is a designed outcome — a
  // tournament that does not exist: the detail query's `queryFn` converts a 404
  // into a router `notFound()`, `params.parse` throws one for a malformed id, and
  // this is the boundary that catches both. `errorComponent` keeps everything that
  // is genuinely an error — 5xx, network, a bad payload, a 403 (→ AccessDenied) —
  // and stays retryable.
  //
  // Declaring `notFoundComponent` here is NOT optional and NOT a fallback to the
  // router's `defaultNotFoundComponent`: a route with none of its own has no
  // not-found boundary mounted at its match at all, so a render-thrown `notFound`
  // would sail past every route to TanStack's generic "Something went wrong!"
  // screen.
  notFoundComponent: TournamentNotFound,
  errorComponent: TournamentRouteError,
})

function TournamentDetailRoute() {
  const { tournamentId } = Route.useParams()
  const { event: openEditorFor } = Route.useSearch()
  const navigate = useNavigate()
  const editorNavigate = Route.useNavigate()
  const router = useRouter()
  const { data: tournament, isPending } = useTournament(tournamentId)
  const allTables = useTables(tournamentId)
  const updateTournament = useUpdateTournament()
  const updateCatalogue = useUpdateTableCatalogue(tournamentId)
  const createEvent = useCreateEvent(tournamentId)
  const updateEvent = useUpdateEvent(tournamentId)
  const deleteEvent = useDeleteEvent(tournamentId)

  const back = () => navigate({ to: '/tournaments' })

  /**
   * **Did WE push the entry the open editor is sitting on?**
   *
   * It decides how the editor closes, and only this component knows the answer.
   * Opening an editor pushes one entry, so closing it must *consume* that entry —
   * otherwise the sheet vanishes and the director is left with a Back press that
   * takes them to an editor they just closed. But an editor reached by a deep link or
   * a reload sits on an entry we never pushed, and there is nothing of ours behind
   * it: popping that one would take them out of the site altogether. That one is
   * replaced instead.
   *
   * A ref, not state: nothing renders from it, and it must be readable by the close
   * handler in the same tick it is written.
   */
  const pushedEditorEntry = useRef(false)

  // The param going away is the entry being consumed, however it happened — our own
  // `history.back()`, or the director's Back press, which never reaches
  // `closeEditor` at all because the pop has already done the work.
  useEffect(() => {
    if (openEditorFor === undefined) pushedEditorEntry.current = false
  }, [openEditorFor])

  /** Open an event's editor: one pushed history entry, so one Back press closes it. */
  const openEditor = (eventKey: string) => {
    pushedEditorEntry.current = true
    void editorNavigate({ search: { event: eventKey } })
  }

  /**
   * Close it — and this is the ONE navigation every close path funnels through
   * (Escape, an overlay click, the sheet's close control, Cancel, a save, a delete),
   * which is what lets a single `useBlocker` in the editor guard all of them.
   *
   * `force` is for the closes that are not a discard: a save has just persisted the
   * work, and a delete is about to raise a confirmation of its own, so neither may
   * stack "Discard changes?" on top. It rides `ignoreBlocker`, which both the pop and
   * the replace path honour.
   *
   * **The flag is not cleared here**, and that is the point: this close can be
   * REFUSED. A dirty editor's pop is blocked, `@tanstack/history` puts the entry
   * straight back, and the director carries on editing — so the entry we pushed is
   * still there and the next close must still pop it. Clearing the flag on the way
   * out would send that next close down the `replace` branch, which strands the
   * pushed entry: the sheet would go, and one Back press would land the director back
   * on the same tournament page instead of leaving it. The effect above is the only
   * thing that clears it, on the one fact that means the entry is really gone — the
   * param disappearing.
   */
  const closeEditor = ({ force = false }: { force?: boolean } = {}) => {
    if (pushedEditorEntry.current) {
      router.history.back({ ignoreBlocker: force })
      return
    }
    void editorNavigate({
      search: { event: undefined },
      replace: true,
      ignoreBlocker: force,
    })
  }

  // First load: the query is pending and `tournament` is still undefined — show a
  // loading state. A resolved 404 no longer lands here at all: the detail query
  // converts it to a router `notFound()`, which this route's `notFoundComponent`
  // catches (ADR-1001), and any genuine error is thrown to `errorComponent`. So a
  // settled, non-pending render always has a `tournament` (the `!tournament` guard
  // below is a type narrowing for that unreachable case, not a UI state).
  if (isPending || !tournament) {
    return (
      <div className="mx-auto flex max-w-[600px] items-center justify-center px-12 py-24 text-center">
        <p className="text-[14px] text-[color:var(--fg-3)]">Loading tournament…</p>
      </div>
    )
  }

  return (
    <TournamentDetailPage
      tournament={tournament}
      allTables={allTables}
      // The open editor, as three facts the page does not have to own: which one the
      // URL names, and the two navigations that change it (#1503).
      openEditorFor={openEditorFor}
      onOpenEditor={openEditor}
      onCloseEditor={closeEditor}
      // `mutateAsync`, and the rejection is deliberately NOT caught here: the
      // `DetailsTab` awaits it, keeps the draft (and its Save affordance) over a
      // refusal, and reports every failure inline — field-level where the server
      // names a box, in the tab's own alert where it cannot (#1593). Catching it
      // here — or letting the mutation toast — would either bin the report or
      // take it away after four seconds, exactly the silent-failure shape #614
      // and #933 ended for the modals.
      onUpdate={async (next) => {
        await updateTournament.mutateAsync({
          id: next.id,
          patch: tournamentToUpdateBody(next),
        })
      }}
      // `mutateAsync`, and the rejection is deliberately NOT caught here: the
      // `TablesTab` awaits it, turns the in-use 409 into a confirm carrying the
      // server's sentence, and re-sends the identical diff with the opt-in when the
      // organizer answers. Catching it here — or letting the mutation toast — would
      // turn the one refusal the director can act on into a message that leaves after
      // four seconds.
      onChangeCatalogue={async (entries, options) => {
        await updateCatalogue.mutateAsync({ entries, ...options })
      }}
      // `mutateAsync`, not `mutate`: the event editor AWAITS these, closes only
      // when they resolve, and renders the failure inline when they don't (the
      // `NewTournamentModal` contract — a modal that closes over a rejected write
      // has silently thrown the user's work away: #614, #933, #934).
      onCreateEvent={async (ev) => {
        await createEvent.mutateAsync(eventToCreateBody(ev))
      }}
      onUpdateEvent={async (ev) => {
        await updateEvent.mutateAsync({
          eventId: ev.id,
          body: eventToUpdateBody(ev),
        })
      }}
      onDeleteEvent={(id) => deleteEvent.mutate(id)}
      // One in-flight write at a time, the way `EnterEventControl` does it: the editor
      // disables its submit control while this is true. It covers a window
      // React-Hook-Form's `isSubmitting` does not — `isPending` stays true through
      // `onSuccess`, which awaits the tournament refetch — and that gap is how five
      // rapid clicks on Create event made five identical events (#1231 QA). Both
      // mutations, one flag: only one of them can be the open editor's.
      savingEvent={createEvent.isPending || updateEvent.isPending}
      onBack={back}
    />
  )
}
