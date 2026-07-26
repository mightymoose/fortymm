import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { TournamentsListPage } from '@/components/tournaments/tournaments-list-page'
import {
  draftToCreateBody,
  useCreateTournament,
  useDeleteTournament,
  useTournaments,
  type TournamentsNearMe,
} from '@/components/tournaments/data/api'
import { useHasPermission } from '@/api/session'
import { PERM } from '@/lib/permissions'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/tournaments/')({
  head: () => ({
    meta: [{ title: pageTitle('Tournaments') }],
  }),
  component: TournamentsRoute,
})

function TournamentsRoute() {
  const navigate = useNavigate()
  // The near-me filter is lifted here, where the list query is called, so a
  // resolved location + radius re-runs it server-side. `undefined` = off (the
  // default, and where a denied/unavailable location snaps back to).
  const [nearMe, setNearMe] = useState<TournamentsNearMe | undefined>(undefined)
  const tournaments = useTournaments(nearMe)
  const createTournament = useCreateTournament()
  const deleteTournament = useDeleteTournament()
  const canCreate = useHasPermission(PERM.TOURNAMENT_CREATE)

  return (
    <TournamentsListPage
      tournaments={tournaments}
      canCreate={canCreate}
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
      onNearMeChange={setNearMe}
    />
  )
}
