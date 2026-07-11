import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import { playerByIdQueryOptions } from '@/api/players'
import { SESSION_QUERY_KEY } from '@/api/session'
import { PlayerProfile } from '@/components/players/player-profile'
import { PlayerRouteError } from '@/components/players/player-route-error'
import { pageTitle } from '@/lib/page-title'

/**
 * The league the **rating half** of the profile is bound to (ADR-0915) — the
 * Leagues card is the switcher that writes it, and the whole hero, the rating
 * panel and the confidence card follow it.
 *
 * Three decisions are packed into these two lines.
 *
 * **`.uuid()`, not a bare string.** The API's `league_id` is a `uuid.UUID`, so
 * FastAPI 422s on `?league=lol` rather than gracefully defaulting. Parsing the
 * format here is what stops the app ever putting one on the wire.
 *
 * **`.catch(undefined)`, so a mangled league degrades rather than errors.** A
 * garbage `?league=` is a broken URL, not a broken app: it falls back to
 * `undefined`, which is the **default league** — the page renders, showing the
 * ladder every player is on. (A *well-formed but unknown* uuid is a different
 * animal: the API 404s it, and it flows to `errorComponent` exactly as an unknown
 * player id does. The client cannot tell valid-unknown from valid-known without
 * the very request that fails.)
 *
 * **`undefined` means default — the param is omitted, not spelled out.** The
 * default league is what a URL with no `?league=` means, so the default league's
 * row in the switcher links to a *clean* `/players/x`. That keeps the URL of the
 * overwhelmingly common case free of a param that says nothing.
 *
 * This schema is deliberately **non-empty**. An exactly-empty `z.object({})`
 * collapses TanStack's inference for every generic `<Link to={string}
 * search={…}>` in the app (it broke the dashboard's "Full history" link when the
 * profile briefly had one) — a real schema is the fix, not the problem.
 */
const profileSearchSchema = z.object({
  league: z.string().uuid().optional().catch(undefined),
})

export const Route = createFileRoute('/_app/players/$userId')({
  head: () => ({
    meta: [{ title: pageTitle('Player') }],
  }),
  validateSearch: zodValidator(profileSearchSchema),
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
  const { league } = Route.useSearch()

  // No page-level fetch: every card projects off the profile bundle's single
  // cache entry and suspends for itself. That query is `throwOnError`, so any
  // non-2xx / network failure flows to `errorComponent` above rather than to a
  // per-card boundary — all the cards share the one query, so a failure means
  // none of them has anything to draw.
  //
  // `league` is part of that cache key, so picking a league in the switcher
  // re-keys the bundle and the rating half of the page refetches — one request,
  // not four, which is why the switch goes through the URL and not through
  // per-card state (ADR-0915). It also means the selection survives a reload for
  // free: the URL is the state.
  return <PlayerProfile playerId={userId} leagueId={league} />
}
