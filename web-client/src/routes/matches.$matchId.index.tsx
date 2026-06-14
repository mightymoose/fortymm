import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetailsError,
  MatchDetailsView,
} from '@/components/matches/match-details-page'
import { matchDetailsQuery } from '@/components/matches/match-details/match-details-query'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/matches/$matchId/')({
  head: () => ({
    meta: [{ title: pageTitle('Match') }],
  }),
  // Warm the React Query cache without blocking the route transition, so the
  // page's self-fetching sections keep streaming in independently on a direct
  // load while a preceding hover/touch preload makes the click render instantly.
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(matchDetailsQuery(params.matchId))
  },
  component: MatchDetailsRoute,
  errorComponent: MatchDetailsError,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  return <MatchDetailsView matchId={matchId} />
}
