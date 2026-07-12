import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

import {
  playerByIdQueryOptions,
  playerQueryKey,
  RATING_RANGES,
} from '@/api/players'
import { SESSION_QUERY_KEY } from '@/api/session'
import { PlayerNotFound } from '@/components/players/player-not-found'
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
 * animal: the API 404s it, and it lands wherever an unknown *player* id lands —
 * which, since ADR-1001, is the `notFoundComponent` below, not the error
 * boundary. The client still cannot tell valid-unknown from valid-known without
 * the very request that fails; the difference is that the request's own failure
 * is now where the not-found is raised, inside the bundle's `queryFn`.)
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
  /**
   * The rating chart's calendar window (ADR-0915) — the range tabs write it, and
   * the chart's query is keyed on it.
   *
   * Same three decisions as `league`, for the same reasons. `.catch(undefined)`
   * degrades a mangled `?range=lol` to the default window rather than erroring or
   * — worse — putting a value on the wire that the API's `Literal["30d","90d","1y"]`
   * would 422.
   *
   * And it stays **optional rather than defaulted**: the default range is the
   * *absence* of the param, so `?range=90d` never appears in a URL and the
   * overwhelmingly common visit stays clean. A `z.enum(...).catch('90d')` without
   * `.optional()` would make `search.range` always `'90d'`, and every
   * `search={(prev) => ({ ...prev })}` link on the page (the Leagues switcher's
   * rows) would start dragging `?range=90d` along behind it.
   */
  range: z.enum(RATING_RANGES).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/players/$userId')({
  head: () => ({
    meta: [{ title: pageTitle('Player') }],
  }),
  validateSearch: zodValidator(profileSearchSchema),
  // The loader must ask for the SAME bundle the cards will ask for, which means it
  // needs the search params — hence `loaderDeps`. Without them it prefetched the
  // league-less, default-range bundle while the page's cards asked for the one the
  // URL actually names, and a cold deep-link paid for it twice over: a `?league=`
  // link is a different cache key, so the page fired TWO bundle requests; and a
  // `?range=` link got a bundle carrying the wrong window, leaving the chart
  // nothing to seed from and sending it off for a third.
  loaderDeps: ({ search }) => ({ league: search.league, range: search.range }),
  // Warm the profile cache on hover/touch preload without blocking navigation —
  // the page's cards all suspend on this same query, so a warm cache paints them
  // instantly. Skip it before the session is resolved so the prefetch can't 401
  // into the error boundary; the `_app` layout loader awaits the session, so by
  // the time this route's component renders the cookie is established (which is
  // what lets the cards fetch with `useSuspenseQuery`, ungated).
  loader: ({ context, params, deps }) => {
    if (!context.queryClient.getQueryData(SESSION_QUERY_KEY)) return
    // Already have this player's bundle? Leave it alone.
    //
    // The loader re-runs whenever its deps change — and `range` is one of them,
    // because a COLD load has to fetch the bundle with the window the URL names.
    // But a range **flip** is also a deps change, and re-prefetching there would
    // put a second, wide request on the wire for a card that exists precisely so
    // that flipping fetches *only* the range (ADR-0915). The bundle does not vary
    // with the range — only the window embedded in it does, and the chart already
    // holds the one it was seeded with — so having it at all is reason enough not
    // to ask again.
    if (context.queryClient.getQueryData(playerQueryKey(params.userId, deps.league)))
      return
    void context.queryClient.prefetchQuery(
      playerByIdQueryOptions(params.userId, deps.league, deps.range),
    )
  },
  component: PlayerRoute,
  // The two boundaries, and the split between them is the whole of ADR-1001.
  // `errorComponent` keeps everything that is genuinely an error — 5xx, network,
  // 401, 403 — and stays retryable. `notFoundComponent` owns the one status that
  // is a designed outcome: the bundle's `queryFn` converts a 404 into a router
  // `notFound()`, and this is the boundary that catches it.
  //
  // Declaring it here is NOT optional and NOT a fallback to the router's
  // `defaultNotFoundComponent`: a route with no `notFoundComponent` of its own has
  // no not-found boundary mounted at that match at all, so a render-thrown
  // `notFound` would sail past every route to TanStack's generic "Something went
  // wrong!" screen. Same for the match-history sub-route, which reads the same
  // query.
  errorComponent: PlayerRouteError,
  notFoundComponent: PlayerNotFound,
})

function PlayerRoute() {
  const { userId } = Route.useParams()
  const { league, range } = Route.useSearch()

  // No page-level fetch: every card projects off the profile bundle's single
  // cache entry and suspends for itself. A failure of that one query flows to a
  // route-level boundary rather than to a per-card one — all the cards share it,
  // so a failure means none of them has anything to draw. Which boundary depends
  // on the status: a 404 is a `notFound()` (the query converts it) and lands in
  // `notFoundComponent`; everything else lands in `errorComponent`.
  //
  // `league` is part of that cache key, so picking a league in the switcher
  // re-keys the bundle and the rating half of the page refetches — one request,
  // not four, which is why the switch goes through the URL and not through
  // per-card state (ADR-0915). It also means the selection survives a reload for
  // free: the URL is the state.
  //
  // `range` is NOT part of that key, and that is the whole point of the chart
  // owning its own query: flipping range must fetch the range and nothing else,
  // keep the painted page (and the old chart) on screen while it does, and fail
  // inside the card if it fails. It rides along on the bundle's *request* all the
  // same, because the bundle embeds the window the chart paints first.
  return <PlayerProfile playerId={userId} leagueId={league} range={range} />
}
