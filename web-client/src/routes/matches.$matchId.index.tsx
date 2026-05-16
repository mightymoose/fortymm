import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetailsError,
  MatchDetailsView,
} from '@/components/matches/match-details-page'

export const Route = createFileRoute('/matches/$matchId/')({
  component: MatchDetailsRoute,
  errorComponent: MatchDetailsError,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  return <MatchDetailsView matchId={matchId} />
}
