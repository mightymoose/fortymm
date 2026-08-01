import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
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
  useUpdateTournament,
} from '@/components/tournaments/data/api'
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
  const navigate = useNavigate()
  const { data: tournament, isPending } = useTournament(tournamentId)
  const allTables = useTables(tournamentId)
  const updateTournament = useUpdateTournament()
  const createEvent = useCreateEvent(tournamentId)
  const updateEvent = useUpdateEvent(tournamentId)
  const deleteEvent = useDeleteEvent(tournamentId)

  const back = () => navigate({ to: '/tournaments' })

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
      onUpdate={(next) =>
        updateTournament.mutate({
          id: next.id,
          patch: tournamentToUpdateBody(next, allTables),
        })
      }
      onChangeCatalogue={(catalogue) =>
        updateTournament.mutate({
          id: tournament.id,
          patch: tournamentToUpdateBody(tournament, catalogue),
        })
      }
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
