import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'

import { TournamentsListPage } from '@/components/tournaments/tournaments-list-page'
import {
  draftToCreateBody,
  useCreateTournament,
  useDeleteTournament,
  useTournaments,
  type TournamentsNearMe,
} from '@/components/tournaments/data/api'
import { tournamentsSearchSchema } from '@/components/tournaments/data/search'
import { useHasPermission } from '@/api/session'
import { PERM } from '@/lib/permissions'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/tournaments/')({
  head: () => ({
    meta: [{ title: pageTitle('Tournaments') }],
  }),
  // The status tab and the search text are URL state, and the URL is a boundary — so a
  // schema parses it here (`.claude/rules/parse-at-boundaries.md`). It degrades rather
  // than throws, so a stale bookmark carrying `?status=someoldvalue` renders the All
  // tab instead of a route error.
  //
  // Deliberately NO loader and NO `loaderDeps`: both filters run client-side over the
  // already-fetched array, so making them query keys would refetch the list on every
  // keystroke for no new data.
  validateSearch: zodValidator(tournamentsSearchSchema),
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
      // The resolved triple IS the "near me is narrowing the list" signal, and it is a
      // truer one than `NearMeControl`'s internal `enabled`: a denied location leaves
      // `enabled` briefly true while the list stays unfiltered, and the empty state
      // would then wrongly blame a filter. The two differ only while locating.
      nearMeActive={nearMe !== undefined}
    />
  )
}
