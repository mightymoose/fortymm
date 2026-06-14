import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { TournamentDetailPage } from '@/components/tournaments/tournament-detail-page'
import {
  createEvent,
  deleteEvent,
  updateEvent,
  updateTournament,
  useTables,
  useTournaments,
} from '@/components/tournaments/data/store'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/tournaments/$tournamentId')({
  head: () => ({
    meta: [{ title: pageTitle('Tournament') }],
  }),
  component: TournamentDetailRoute,
})

function TournamentDetailRoute() {
  const { tournamentId } = Route.useParams()
  const navigate = useNavigate()
  const tournaments = useTournaments()
  const allTables = useTables()
  const tournament = tournaments.find((t) => t.id === tournamentId)

  const back = () => navigate({ to: '/tournaments' })

  if (!tournament) {
    return (
      <AppShell>
        <div className="mx-auto flex max-w-[600px] flex-col items-center gap-4 px-12 py-24 text-center">
          <h1 className="text-[20px] font-semibold text-[color:var(--fg-1)]">
            Tournament not found
          </h1>
          <p className="text-[14px] text-[color:var(--fg-3)]">
            It may have been deleted, or the link is wrong.
          </p>
          <Button onClick={back}>Back to tournaments</Button>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <TournamentDetailPage
        tournament={tournament}
        allTables={allTables}
        onUpdate={updateTournament}
        onCreateEvent={(ev) => createEvent(tournament.id, ev)}
        onUpdateEvent={(ev) => updateEvent(tournament.id, ev)}
        onDeleteEvent={(id) => deleteEvent(tournament.id, id)}
        onBack={back}
      />
    </AppShell>
  )
}
