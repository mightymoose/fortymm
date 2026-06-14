import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { TournamentsListPage } from '@/components/tournaments/tournaments-list-page'
import {
  createTournament,
  deleteTournament,
  useTournaments,
} from '@/components/tournaments/data/store'
import { pageTitle } from '@/lib/page-title'

// Tournament-admin (Tournament CRUD) routes are intentionally not linked from
// the sidebar nav — they're reached directly by URL for now.
export const Route = createFileRoute('/tournaments/')({
  head: () => ({
    meta: [{ title: pageTitle('Tournaments') }],
  }),
  component: TournamentsRoute,
})

function TournamentsRoute() {
  const navigate = useNavigate()
  const tournaments = useTournaments()

  return (
    <AppShell>
      <TournamentsListPage
        tournaments={tournaments}
        onOpen={(tournamentId) =>
          navigate({
            to: '/tournaments/$tournamentId',
            params: { tournamentId },
          })
        }
        onCreate={(draft) => {
          const tournamentId = createTournament(draft)
          navigate({
            to: '/tournaments/$tournamentId',
            params: { tournamentId },
          })
        }}
        onDelete={deleteTournament}
      />
    </AppShell>
  )
}
