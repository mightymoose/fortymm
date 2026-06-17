import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { TournamentsListPage } from '@/components/tournaments/tournaments-list-page'
import {
  draftToCreateBody,
  useCreateTournament,
  useDeleteTournament,
  useTournaments,
} from '@/components/tournaments/data/api'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/tournaments/')({
  head: () => ({
    meta: [{ title: pageTitle('Tournaments') }],
  }),
  component: TournamentsRoute,
})

function TournamentsRoute() {
  const navigate = useNavigate()
  const tournaments = useTournaments()
  const createTournament = useCreateTournament()
  const deleteTournament = useDeleteTournament()

  return (
    <TournamentsListPage
      tournaments={tournaments}
      onOpen={(tournamentId) =>
        navigate({
          to: '/tournaments/$tournamentId',
          params: { tournamentId },
        })
      }
      onCreate={async (draft) => {
        const created = await createTournament.mutateAsync(
          draftToCreateBody(draft),
        )
        navigate({
          to: '/tournaments/$tournamentId',
          params: { tournamentId: created.id },
        })
      }}
      onDelete={(id) => deleteTournament.mutate(id)}
    />
  )
}
