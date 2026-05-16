import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetailsError,
  MatchDetailsView,
} from '@/components/matches/match-details-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/matches/$matchId/')({
  head: () => ({
    meta: [{ title: pageTitle('Match') }],
  }),
  component: MatchDetailsRoute,
  errorComponent: MatchDetailsError,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  return <MatchDetailsView matchId={matchId} />
}
