import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetailsError,
  MatchDetailsView,
} from '@/components/matches/match-details-page'
import { matchDetailsQuery } from '@/components/matches/match-details/match-details-query'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/p/matches/$matchId')({
  head: () => ({
    meta: [{ title: pageTitle('Match') }],
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(matchDetailsQuery(params.matchId)),
  component: PublicMatchDetailsRoute,
  errorComponent: PublicMatchDetailsError,
})

function PublicMatchDetailsRoute() {
  const { matchId } = Route.useParams()
  return <MatchDetailsView matchId={matchId} standalone />
}

function PublicMatchDetailsError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  return <MatchDetailsError error={error} reset={reset} standalone />
}
