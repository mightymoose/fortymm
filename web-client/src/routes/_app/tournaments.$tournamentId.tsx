import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { TournamentDetailPage } from '@/components/tournaments/tournament-detail-page'
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

export const Route = createFileRoute('/_app/tournaments/$tournamentId')({
  head: () => ({
    meta: [{ title: pageTitle('Tournament') }],
  }),
  component: TournamentDetailRoute,
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

  // First load: the query is pending and `tournament` is still undefined.
  // Show a loading state rather than the not-found screen (which is only for a
  // resolved 404).
  if (isPending) {
    return (
      <div className="mx-auto flex max-w-[600px] items-center justify-center px-12 py-24 text-center">
        <p className="text-[14px] text-[color:var(--fg-3)]">Loading tournament…</p>
      </div>
    )
  }

  // `useTournament` resolves to `null` on a 404 (a 403 bubbles to the
  // RbacBoundary instead); show the not-found screen only after loading settles.
  if (!tournament) {
    return (
      <div className="mx-auto flex max-w-[600px] flex-col items-center gap-4 px-12 py-24 text-center">
        <h1 className="text-[20px] font-semibold text-[color:var(--fg-1)]">
          Tournament not found
        </h1>
        <p className="text-[14px] text-[color:var(--fg-3)]">
          It may have been deleted, or the link is wrong.
        </p>
        <Button onClick={back}>Back to tournaments</Button>
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
      onCreateEvent={(ev) => createEvent.mutate(eventToCreateBody(ev))}
      onUpdateEvent={(ev) =>
        updateEvent.mutate({ eventId: ev.id, body: eventToUpdateBody(ev) })
      }
      onDeleteEvent={(id) => deleteEvent.mutate(id)}
      onBack={back}
    />
  )
}
