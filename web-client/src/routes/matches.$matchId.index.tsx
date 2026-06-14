import { createFileRoute } from '@tanstack/react-router'
import {
  MatchDetails,
  MatchDetailsError,
} from '@/components/matches/match-details'
import { matchDetailsQuery } from '@/components/matches/match-details/match-details-query'
import { ApiError } from '@/api/client'
import { pageTitle } from '@/lib/page-title'

// Match ids are UUIDs. A malformed id (e.g. /matches/not-a-uuid) would 422 on
// every self-fetching section and surface an `ApiError` in the console even
// though the UI handles it (#494). Guarding the param shape client-side means
// we never make the request: no 422, no console error — just the friendly
// not-found state the boundary already renders for a 404/422.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const Route = createFileRoute('/matches/$matchId/')({
  head: () => ({
    meta: [{ title: pageTitle('Match') }],
  }),
  // Warm the React Query cache without blocking the route transition, so the
  // page's self-fetching sections keep streaming in independently on a direct
  // load while a preceding hover/touch preload makes the click render instantly.
  loader: ({ context, params }) => {
    if (!UUID_RE.test(params.matchId)) return
    void context.queryClient.prefetchQuery(matchDetailsQuery(params.matchId))
  },
  component: MatchDetailsRoute,
  errorComponent: MatchDetailsError,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  if (!UUID_RE.test(matchId)) {
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
