import { useCallback } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { playerByIdQueryOptions, usePlayerById } from '@/api/players'
import { SESSION_QUERY_KEY, useSession } from '@/api/session'
import { PlayerMatchHistory } from '@/components/players/player-match-history'
import { PlayerNotFound } from '@/components/players/player-not-found'
import { PlayerRouteError } from '@/components/players/player-route-error'
import { pageTitle } from '@/lib/page-title'

// Pagination lives in the URL so refresh / share / back works. A junk `?page=`
// falls back to page 1 rather than erroring at the boundary; an out-of-range
// one snaps back to the last real page once the total is known (#637).
const historySearchSchema = z.object({
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/players/$userId_/matches')({
  head: () => ({
    meta: [{ title: pageTitle('Match history') }],
  }),
  validateSearch: zodValidator(historySearchSchema),
  // Warm the profile cache on hover/touch preload without blocking navigation.
  // Skip on a cold direct load where the session isn't resolved yet, so the
  // prefetch can't 401 into the error boundary ahead of the component's
  // session-gated query (same pattern as the profile route).
  loader: ({ context, params }) => {
    if (!context.queryClient.getQueryData(SESSION_QUERY_KEY)) return
    void context.queryClient.prefetchQuery(
      playerByIdQueryOptions(params.userId),
    )
  },
  component: PlayerMatchHistoryRoute,
  errorComponent: PlayerRouteError,
  // This route reads the SAME profile bundle as `/players/$userId`, so it 404s the
  // same way and needs its own not-found boundary (ADR-1001). It does not inherit
  // the profile route's — this is a sibling, not a child — and it cannot fall back
  // to the router's `defaultNotFoundComponent`, which never sees a render-thrown
  // `notFound`. Without this line, an unknown player id here renders TanStack's
  // generic "Something went wrong!" screen.
  notFoundComponent: PlayerNotFound,
})

function PlayerMatchHistoryRoute() {
  const { userId } = Route.useParams()
  const search = Route.useSearch()
  const page = search.page ?? 1
  const navigate = useNavigate()

  // The heading needs the player's identity; the profile bundle is the natural
  // source and is usually a cache hit when the user arrived from the profile.
  // Gate on the session so a first-visit direct-load doesn't race the session
  // cookie. The query is `throwOnError`, so a failure flows to a route boundary
  // above — a 404 to `notFoundComponent`, anything else to `errorComponent`; the
  // matches list keeps its own inline retry.
  const session = useSession()
  const { data: player, isPending } = usePlayerById(userId, {
    enabled: session.isSuccess,
  })

  const setPage = useCallback(
    (next: number) => {
      void navigate({
        to: '/players/$userId/matches',
        params: { userId },
        replace: true,
        search: { page: next > 1 ? next : undefined },
      })
    },
    [navigate, userId],
  )

  return (
    <PlayerMatchHistory
      playerId={userId}
      player={player ?? null}
      isPending={isPending}
      page={page}
      onPageChange={setPage}
    />
  )
}
