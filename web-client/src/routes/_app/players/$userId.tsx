import { createFileRoute } from '@tanstack/react-router'

import { playerByIdQueryOptions } from '@/api/players'
import { SESSION_QUERY_KEY } from '@/api/session'
import { PlayerProfile } from '@/components/players/player-profile'
import { PlayerRouteError } from '@/components/players/player-route-error'
import { pageTitle } from '@/lib/page-title'

// The profile is an overview and owns **no search params**: `?page=` left with
// the table for `/players/$userId/matches` (ADR-0915), and nothing has replaced
// it yet — so there is no `validateSearch` here, and nothing on the page reads
// the URL's search. A stale `/players/x?page=3` bookmark therefore degrades
// harmlessly: the page renders and the leftover param is simply never consumed.
//
// It is deliberately *not* a `zodValidator(z.object({}))`: an exactly-empty
// search schema collapses TanStack's inference for every generic
// `<Link to={string} search={…}>` in the app (the dashboard's "Full history"
// link stops type-checking). Slices 6 and 8 bring a real schema back with
// `league` and `range` in it.
export const Route = createFileRoute('/_app/players/$userId')({
  head: () => ({
    meta: [{ title: pageTitle('Player') }],
  }),
  // Warm the profile cache on hover/touch preload without blocking navigation —
  // the page's cards all suspend on this same query, so a warm cache paints them
  // instantly. Skip it before the session is resolved so the prefetch can't 401
  // into the error boundary; the `_app` layout loader awaits the session, so by
  // the time this route's component renders the cookie is established (which is
  // what lets the cards fetch with `useSuspenseQuery`, ungated).
  loader: ({ context, params }) => {
    if (!context.queryClient.getQueryData(SESSION_QUERY_KEY)) return
    void context.queryClient.prefetchQuery(
      playerByIdQueryOptions(params.userId),
    )
  },
  component: PlayerRoute,
  errorComponent: PlayerRouteError,
})

function PlayerRoute() {
  const { userId } = Route.useParams()

  // No page-level fetch: every card projects off the profile bundle's single
  // cache entry and suspends for itself. That query is `throwOnError`, so any
  // non-2xx / network failure flows to `errorComponent` above rather than to a
  // per-card boundary — all the cards share the one query, so a failure means
  // none of them has anything to draw.
  return <PlayerProfile playerId={userId} />
}
