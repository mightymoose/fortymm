import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetails,
  MatchDetailsError,
} from '@/components/matches/match-details'
import { matchDetailsQuery } from '@/components/matches/match-details/match-details-query'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/matches/$matchId/')({
  head: () => ({
    meta: [{ title: pageTitle('Match') }],
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(matchDetailsQuery(params.matchId)),
  component: MatchDetailsRoute,
  errorComponent: MatchDetailsError,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  return <MatchDetails matchId={matchId} />
}
