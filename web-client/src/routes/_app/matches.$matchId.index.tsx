import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetails,
  MatchDetailsError,
} from '@/components/matches/match-details'
import { matchDetailsQuery } from '@/components/matches/match-details/match-details-query'
import { ApiError } from '@/api/client'
import { pageTitle } from '@/lib/page-title'
import { isMatchId } from '@/lib/match-id'

export const Route = createFileRoute('/_app/matches/$matchId/')({
  head: () => ({
    meta: [{ title: pageTitle('Match') }],
  }),
  // Warm the React Query cache without blocking the route transition, so the
  // page's self-fetching sections keep streaming in independently on a direct
  // load while a preceding hover/touch preload makes the click render instantly.
  loader: ({ context, params }) => {
    if (!isMatchId(params.matchId)) return
    void context.queryClient.prefetchQuery(matchDetailsQuery(params.matchId))
  },
  component: MatchDetailsRoute,
  errorComponent: MatchDetailsError,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  if (!isMatchId(matchId)) {
    // Reuse the page's not-found UI without ever hitting the API.
    return (
      <MatchDetailsError
        error={new ApiError(404, null, `load match ${matchId}`)}
        reset={() => {}}
      />
    )
  }
  return <MatchDetails matchId={matchId} />
}
