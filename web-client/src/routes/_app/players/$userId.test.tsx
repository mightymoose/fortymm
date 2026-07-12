import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { PlayerDetail, RatingRange } from '@/api/players'
import { SESSION_QUERY_KEY } from '@/api/session'
import type { RouterContext } from '@/routes/__root'
import {
  buildDefaultLeague,
  buildFirmingUpConfidence,
  buildPlayerCareer,
  buildPlayerDetail,
  buildRatingConfidence,
  buildSecondLeague,
  buildUnratedPlayerDetail,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import {
  buildLiveMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import {
  buildRatingHistoryWindow,
  buildRatingPoint,
  daysAgo,
} from '@/mocks/factories/players/rating-history.factory'
import { playerNotFoundPage } from '@/components/players/player-not-found.page'
import { ratingChartDisplayPage } from '@/components/players/player-profile/rating-chart/rating-chart-fetcher/rating-chart-display.page'
import { ratingPanelDisplayPage } from '@/components/players/player-profile/rating-panel/rating-panel-fetcher/rating-panel-display.page'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { Route } from './$userId'

const ProfileRoute = Route.options.component!
const ProfileError = Route.options.errorComponent!
/** The route's OWN not-found boundary (ADR-1001). Read off the shipped route
 * rather than passed in by the harness: a route that forgets to declare one has
 * no not-found boundary at its match at all, so the `notFound()` the profile
 * bundle throws would escape to TanStack's generic "Something went wrong!"
 * screen. This is `undefined` if the route drops it — and the tests below then
 * render exactly that generic screen and go red. */
const ProfileNotFound = Route.options.notFoundComponent

/** The route's shipped loader and its deps, typed loosely enough to hang off a
 * bare root route in this harness. They are the real functions — nothing here
 * re-implements them. */
const shippedLoaderDeps = Route.options.loaderDeps as unknown as (opts: {
  search: { league?: string; range?: RatingRange }
}) => { league?: string; range?: RatingRange }
const shippedLoader = Route.options.loader as unknown as (opts: unknown) => void

/**
 * Stub the session and the profile bundle every card projects off — and nothing
 * else. The profile is an overview now: it reads the six recent matches out of
 * that bundle, so `/v1/players/:id/matches` is deliberately left unstubbed and
 * MSW (`onUnhandledRequest: 'error'`) fails the test if the page calls it.
 */
function mockProfile(bundle: PlayerDetail) {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get('*/v1/players/:playerId', () => HttpResponse.json(bundle)),
  )
}

/**
 * The **cross-league** career every bundle below carries — byte-identical
 * whichever league is asked for, because that is exactly what the API promises
 * (ADR-0915): a career is a fact about the *person*, and counts every league
 * they play in.
 *
 * It is deliberately NOT equal to either league's top-level `wins`/`losses`,
 * which *are* league-scoped. That gap is what makes "career doesn't change"
 * a real assertion: a Career card that read the top-level record would print
 * "24 W · 11 L" on FortyMM and "3 W · 1 L" on USATT, and the tests below would
 * catch it.
 */
const CROSS_LEAGUE_CAREER = buildPlayerCareer({
  decided: 35,
  wins: 24,
  losses: 11,
  win_rate: 24 / 35,
  league_count: 2,
})

/**
 * A player on two ladders, answered **per league** — the shape the real API
 * sends, and the only stub that can prove a switch actually switched.
 *
 * The rating half differs by league (rating, rank, and confidence), and every
 * league-independent block — `career`, `leagues` — comes back identical. That is
 * the contract; a stub that varied career too would let a broken page pass, and a
 * stub that varied *nothing* would let a page that never refetched pass.
 */
function mockLeagueScopedProfile() {
  const leagues = [buildDefaultLeague(), buildSecondLeague()]
  const fortymm = buildPlayerDetail({
    username: 'rita.kovac',
    rating: 1687,
    rank: 3,
    rank_of: 42,
    // The record ON THIS LADDER — league-scoped, and not the career's.
    wins: 24,
    losses: 11,
    confidence: buildRatingConfidence(),
    career: CROSS_LEAGUE_CAREER,
    leagues,
  })
  const usatt = buildPlayerDetail({
    username: 'rita.kovac',
    rating: 1642,
    rank: 7,
    rank_of: 15,
    // A different ladder, a different record on it — but the SAME career.
    wins: 3,
    losses: 1,
    confidence: buildFirmingUpConfidence(),
    career: CROSS_LEAGUE_CAREER,
    leagues,
  })

  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get('*/v1/players/:playerId', ({ request }) => {
      const leagueId = new URL(request.url).searchParams.get('league_id')
      // No `league_id` means the default league — that is what the URL with no
      // `?league=` means, and what the API answers with.
      return HttpResponse.json(leagueId === USATT_LEAGUE_ID ? usatt : fortymm)
    }),
  )
}

/** The profile bundle fails — every card is projected off it, so nothing on the
 * page has anything to draw. */
function mockProfileFailure(status = 500) {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get(
      '*/v1/players/:playerId',
      () => new HttpResponse(null, { status }),
    ),
  )
}

/**
 * A QueryClient that **retries** — the only kind that can prove a query doesn't.
 *
 * In a browser, React Query's own default is `retry: 3` with backoff, and the
 * app's `QueryClient` (`main.tsx`) overrides nothing, so that default is the
 * ambient policy every query inherits unless it opts out. **Under vitest it is
 * not**: query-core's `environmentManager` reports this environment as a server
 * (`retry ?? (isServer ? 0 : 3)`), so an *unset* `retry` silently means "don't
 * retry" here — measured, not assumed. A test that left `retry` unset on the
 * client would therefore pass whether or not the bundle opted out, which is a
 * test that proves nothing.
 *
 * So the ambient policy is spelled out explicitly (`retry: 3`, and a 1ms delay so
 * the test doesn't sit through the real backoff). The query's own `retry: false`
 * has to beat it. Delete that line from `playerByIdQueryOptions` and this client
 * retries the 404 three times over — which is exactly the user-visible defect:
 * seconds of skeleton before being told the player doesn't exist.
 */
function retryingQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 3, retryDelay: 1 },
    },
  })
}

/**
 * @param existing a QueryClient from an earlier render, to carry its cache across
 *   an unmount — which is how a real user's second visit to a profile works, and
 *   the only way to catch a card that seeds itself from a *stale* bundle. Also
 *   how a test opts out of the fast `retry: false` default above.
 */
function renderProfile(initialEntry = '/players/p-1', existing?: QueryClient) {
  const queryClient =
    existing ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  // The route's loader skips its prefetch until the session is resolved (so it
  // cannot 401 into the error boundary), and in production the `_app` layout
  // loader has already awaited it. Seed it, or the loader below is a no-op and
  // every claim about what it prefetches would be vacuous.
  queryClient.setQueryData(SESSION_QUERY_KEY, sessionResponse())
  // The root carries the app's router context, because the route under test has a
  // real `loader` and that loader reaches for `context.queryClient`. A contextless
  // root would not type-check against it — which is the compiler noticing, quite
  // correctly, that this harness is now exercising the loader.
  const rootRoute = createRootRouteWithContext<RouterContext>()()
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId',
    component: ProfileRoute,
    errorComponent: ProfileError,
    // The SHIPPED not-found boundary, not one this harness invents. Drop the line
    // from the route and this is `undefined` — which is precisely the failure
    // mode ADR-1001 warns about, and the 404 tests below reproduce it.
    notFoundComponent: ProfileNotFound,
    validateSearch: Route.options.validateSearch,
    // The REAL loader and its deps. Wiring them is the only way to catch the bug
    // they exist for: a loader that prefetched the league-less, default-range
    // bundle while the page's cards asked for the one the URL names would fire a
    // second bundle request (a different league is a different cache key) and
    // leave the chart nothing to seed from (the wrong window came back inside it).
    // The REAL `loaderDeps` and `loader`, reached through the two aliases above:
    // the shipped functions run, they are simply detached from the generated route
    // tree's parent chain (the file route's parent is `_app`, not this harness's
    // root). A harness that re-implemented `loaderDeps` here could not catch a
    // route that dropped it — which is the whole bug this covers.
    loaderDeps: ({ search }) => shippedLoaderDeps({ search }),
    loader: (opts) => shippedLoader(opts),
  })
  // The Recent matches card's footer is a typed <Link> to the full history, so
  // the route it opens must be registered for the link to resolve.
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId/matches',
    component: () => <div>match history</div>,
  })
  // The not-found state's one recovery action is a typed <Link to="/players">, so
  // the players list has to exist in the tree for it to resolve — and to be
  // followable, which is what makes "it is not a dead end" a real claim.
  const playersListRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players',
    component: () => <div>players list</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      playersListRoute,
      profileRoute,
      historyRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: { queryClient },
  })
  // The router comes back so a test can read the URL the page navigated to — the
  // league selection IS the URL (ADR-0915), so "it went into the URL" is a claim
  // that has to be checked against the real thing, not against a rendered class.
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
    queryClient,
  }
}

/** The two rows of the Leagues card — the switcher's controls. */
const usattRow = () => screen.getByRole('link', { name: /USATT/ })
const fortymmRow = () => screen.getByRole('link', { name: /FortyMM/ })

/**
 * The **hero's** rating — the big chip in the rating panel.
 *
 * Scoped, not a bare `getByText('1687')`, and that is load-bearing: the Leagues
 * card prints ratings too, and after a switch the FortyMM row *still* reads 1687,
 * quite correctly — FortyMM's rating did not change, it merely stopped being the
 * one the page is about. A page-wide text query could neither tell the two apart
 * nor assert the hero stopped showing the old ladder's number.
 */
const heroRating = () => ratingPanelDisplayPage.getRating()

describe('player profile route', () => {
  it('paints the hero — rating, rank of the ladder, peak, form and member-since', async () => {
    mockProfile(
      buildPlayerDetail({
        username: 'rita.kovac',
        rating: 1687,
        rank: 3,
        rank_of: 42,
        peak: 1712,
        member_since: '2024-03-14T09:00:00Z',
        form: 'WWLWLLWWLW',
      }),
    )

    renderProfile()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'rita.kovac' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Member since Mar 2024')).toBeInTheDocument()
    // Scoped to the hero's chip: the Leagues card prints this player's rating on
    // each of their ladders, so "1687" is legitimately on the page twice.
    expect(heroRating()).toHaveTextContent('1687')
    // The rank is always reported out of the rated population — never "#3".
    expect(screen.getByText('#3 of 42')).toBeInTheDocument()
    expect(screen.getByText('1712')).toBeInTheDocument()
    // Ten results on the profile (the roster is the surface that shows five).
    expect(
      screen.getByLabelText('Last 10: W W L W L L W W L W'),
    ).toBeInTheDocument()
  })

  it('shows recent matches, with a link to the all-inclusive history', async () => {
    // 24 + 11 = 35 decided, 50 all-inclusive. The link names *fifty*, and the
    // live match is on the card rather than filtered out of it (ADR-0915).
    mockProfile(
      buildPlayerDetail({
        wins: 24,
        losses: 11,
        match_total: 50,
        matches: buildPlayerMatchList([
          buildPlayerMatchRow({
            opponent: { id: 'p-9', username: 'ada.lovelace' },
          }),
          buildLiveMatchRow({ opponent: { id: 'p-8', username: 'kai.zhou' } }),
        ]),
      }),
    )

    renderProfile()

    const link = await screen.findByRole('link', {
      name: 'View all 50 matches',
    })
    expect(link).toHaveAttribute('href', '/players/p-1/matches')
    expect(screen.getByText('kai.zhou')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Live' })).toBeInTheDocument()
    // No result-chip column survives on the profile.
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
  })

  it('renders a stale “?page=” bookmark harmlessly', async () => {
    // `?page=` left the profile with the table (ADR-0915). An old
    // `/players/x?page=3` link must still open the profile — the param is simply
    // never consumed — rather than 404ing or erroring at the boundary.
    mockProfile(buildPlayerDetail({ username: 'rita.kovac' }))

    renderProfile('/players/p-1?page=3')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'rita.kovac' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an unrated player as Unrated, with no rank', async () => {
    // No rating, no rank — CONTEXT.md § Rank. Not a big number at the bottom of
    // the ladder, and not a "#null of 42".
    mockProfile(buildUnratedPlayerDetail({ username: 'park.j' }))

    renderProfile('/players/p-2')

    expect(await screen.findByText('Unrated')).toBeInTheDocument()
    expect(screen.queryByText(/^#\d+ of \d+$/)).not.toBeInTheDocument()
    expect(screen.queryByText('Rank')).not.toBeInTheDocument()
    expect(screen.queryByText('Peak')).not.toBeInTheDocument()
  })

  it('sends a failed bundle to the route’s error boundary', async () => {
    // No per-card boundary: the cards share one query, so a failure means none
    // of them has anything to draw.
    mockProfileFailure(500)

    renderProfile()

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})

/**
 * The error taxonomy (ADR-1001). A missing player and a broken server are two
 * different things and land in two different boundaries, and the whole risk of
 * that change is that the *second* one quietly stops working — a 5xx that says
 * "Player not found." with no way to retry is a worse bug than the one being
 * fixed. So each of the two states is asserted positively **and** against the
 * other.
 */
describe('player profile — a missing player is a not-found, not an error', () => {
  /** The profile bundle 404s: a well-formed id that names nobody. */
  function mockMissingPlayer(onRequest?: () => void) {
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () => {
        onRequest?.()
        return HttpResponse.json({ detail: 'Player not found.' }, { status: 404 })
      }),
    )
  }

  const notFoundPage = playerNotFoundPage.within(screen)

  it('renders the designed not-found page — not the error boundary', async () => {
    mockMissingPlayer()

    renderProfile('/players/00000000-0000-0000-0000-000000000000')

    // The designed state, with the copy that names what was missing…
    expect(await notFoundPage.findHeadline()).toHaveTextContent(
      'Player not found.',
    )
    expect(notFoundPage.getBody(/no player with that id/i)).toBeInTheDocument()
    // …and NOT the error boundary (which no longer has a 404 branch at all)…
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/couldn’t load this player/i),
    ).not.toBeInTheDocument()
    // …and NOT TanStack's generic screen, which is what a route that forgot its
    // own `notFoundComponent` would render (the `defaultNotFoundComponent` never
    // sees a render-thrown `notFound`).
    expect(screen.queryByText(/something went wrong!/i)).not.toBeInTheDocument()
    // …and no half-painted profile behind it.
    expect(
      screen.queryByRole('heading', { level: 1, name: /rita/i }),
    ).not.toBeInTheDocument()
  })

  it('is not a dead end — the one action lands on the players list', async () => {
    // The whole of #1001: the old 4xx branch rendered no action at all, so
    // enumerating the links in `main` returned `[]` and the only escape was the
    // browser's back button. Assert the link is *followable*, not merely present.
    const user = userEvent.setup()
    mockMissingPlayer()

    const { router } = renderProfile('/players/nobody')
    await notFoundPage.findHeadline()

    const actions = notFoundPage.getActions()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toHaveAccessibleName('Back to players')

    await user.click(actions[0])

    expect(await screen.findByText('players list')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/players')
  })

  it('surfaces the missing player at ONCE — a 404 is never retried', async () => {
    // A 404 will fail identically every time, so retrying it only buys the user a
    // few seconds of skeleton before being told the player doesn't exist. The
    // bundle's `retry: false` is what declines the ambient retry policy — in a
    // browser, React Query's own default of THREE with backoff, which the app's
    // QueryClient does not override — so this runs on a client that ACTUALLY
    // RETRIES (see `retryingQueryClient`; the file's other client, and vitest's
    // environment, would not).
    //
    // Take `retry: false` off `playerByIdQueryOptions` and this goes red on the
    // count: the missing player is fetched four times before the not-found page
    // is allowed to paint.
    let requests = 0
    mockMissingPlayer(() => {
      requests += 1
    })

    renderProfile('/players/nobody', retryingQueryClient())

    expect(await notFoundPage.findHeadline()).toHaveTextContent(
      'Player not found.',
    )
    expect(requests).toBe(1)
  })

  it('still sends a 5xx to the error boundary — with a Try again that works', async () => {
    // The regression this change most endangers. A server error is NOT a missing
    // player: the player may well exist, the request simply failed, and the user
    // must be able to try it again. If this ever renders "Player not found.", or
    // renders it without a working retry, the taxonomy has been mis-split.
    const user = userEvent.setup()
    let attempts = 0
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () => {
        attempts += 1
        // Fail once, then recover — so "Try again" has something to succeed at.
        if (attempts === 1) return new HttpResponse(null, { status: 500 })
        return HttpResponse.json(buildPlayerDetail({ username: 'rita.kovac' }))
      }),
    )

    renderProfile()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load this player.')
    // Emphatically not the not-found page…
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Player not found.' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/no player with that id/i)).not.toBeInTheDocument()

    // …and the retry is real: it refetches and the profile paints.
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'rita.kovac' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(attempts).toBeGreaterThan(1)
  })

  it.each([401, 403])(
    'keeps a bare %i retryable — an error, never “Player not found.”',
    async (status) => {
      // The other two statuses that are still 4xx and still land in the error
      // boundary. Since ADR-1001 that boundary has exactly ONE branch, so their
      // correctness holds *by construction* — and nothing would catch a future
      // change that reintroduced branching and stranded a 401 in the actionless
      // dead end #1001 filed. So pin them: both must render the error state,
      // both must offer a working Try again, and neither may be told the player
      // doesn't exist.
      //
      // A **bare** 401 on purpose (an empty body, no structured `session_ended` /
      // `session_merged` code): a session-ended 401 never reaches a boundary at
      // all — the API client's global handler intercepts it and redirects to
      // `/login`. This is the ordinary auth failure that a retry can clear.
      const user = userEvent.setup()
      let attempts = 0
      server.use(
        http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
        http.get('*/v1/players/:playerId', () => {
          attempts += 1
          // Fail once, then recover — so "Try again" has something to succeed at.
          if (attempts === 1) return new HttpResponse(null, { status })
          return HttpResponse.json(buildPlayerDetail({ username: 'rita.kovac' }))
        }),
      )

      renderProfile()

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Couldn’t load this player.')
      // Not the not-found state, in either of its two tells.
      expect(screen.queryByText(/player not found/i)).not.toBeInTheDocument()
      expect(
        screen.queryByText(/no player with that id/i),
      ).not.toBeInTheDocument()

      // …and it is not a dead end: the one action retries, and the retry works.
      await user.click(screen.getByRole('button', { name: 'Try again' }))

      expect(
        await screen.findByRole('heading', { level: 1, name: 'rita.kovac' }),
      ).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(attempts).toBeGreaterThan(1)
    },
  )
})

/**
 * The Leagues card is the page's **league switcher** (ADR-0915), and these are
 * the four claims that make it one. Every stub below answers *per league* — the
 * rating half differs, the career block is byte-identical — because a stub that
 * answered the same thing to both would let a page that never refetched pass.
 */
describe('player profile — the league switcher', () => {
  it('rebinds the rating half of the page to the league you pick, and puts it in the URL', async () => {
    mockLeagueScopedProfile()

    const { router } = renderProfile()

    // The default league: FortyMM's numbers, and a clean URL.
    await screen.findByText('#3 of 42')
    expect(heroRating()).toHaveTextContent('1687')
    expect(screen.getByText('Settled')).toBeInTheDocument()
    expect(router.state.location.searchStr).toBe('')

    await userEvent.click(usattRow())

    // The rating, the rank AND the confidence all follow the ladder — they are
    // facts about a league, not about a person. If any of them still read
    // FortyMM's, the switch only moved a highlight.
    await screen.findByText('#7 of 15')
    await waitFor(() => expect(heroRating()).toHaveTextContent('1642'))
    expect(screen.getByText('Firming up')).toBeInTheDocument()
    // The hero has stopped showing the *other* ladder's numbers. (The Leagues
    // card still prints 1687 on the FortyMM row, and should: that rating is real,
    // it is simply not the one the page is now about.)
    expect(heroRating()).not.toHaveTextContent('1687')
    expect(screen.queryByText('#3 of 42')).not.toBeInTheDocument()
    expect(screen.queryByText('Settled')).not.toBeInTheDocument()

    // …and the selection is in the URL, which is what makes it shareable and
    // reloadable at all.
    expect(router.state.location.search).toEqual({ league: USATT_LEAGUE_ID })
  })

  it('leaves CAREER alone when the league changes — a career is a fact about the person', async () => {
    // The bug ADR-0915 exists to prevent. The stub's two bundles carry *different*
    // top-level (league-scoped) records — 24 W · 11 L on FortyMM, 3 W · 1 L on
    // USATT — and the *same* career block. So a Career card that read the
    // top-level record would visibly flip to "3 W · 1 L" here, and this test
    // would go red.
    mockLeagueScopedProfile()

    renderProfile()

    expect(await screen.findByText('24 W · 11 L')).toBeInTheDocument()
    expect(screen.getByText('35 decided · 2 leagues')).toBeInTheDocument()

    await userEvent.click(usattRow())

    // The rating moved…
    await waitFor(() => expect(heroRating()).toHaveTextContent('1642'))
    // …and the career did not.
    expect(screen.getByText('24 W · 11 L')).toBeInTheDocument()
    expect(screen.getByText('35 decided · 2 leagues')).toBeInTheDocument()
    expect(screen.queryByText('3 W · 1 L')).not.toBeInTheDocument()
  })

  it('keeps the selection across a reload — the URL is the state', async () => {
    // A cold load straight at `?league=<usatt>`: exactly what the browser does on
    // F5. If the selection lived in component state, this would come back showing
    // FortyMM.
    mockLeagueScopedProfile()

    renderProfile(`/players/p-1?league=${USATT_LEAGUE_ID}`)

    await screen.findByText('#7 of 15')
    expect(heroRating()).toHaveTextContent('1642')
    expect(heroRating()).not.toHaveTextContent('1687')
    // The card agrees with the page: USATT is the selected row, and it is the
    // ONLY one. (The router marks any link it thinks is active with the same
    // attribute, and under its default partial search matching the default
    // league's row — whose search is `{}` — matches every URL. Two current
    // ladders is worse than none, so assert the negative too.)
    expect(usattRow()).toHaveAttribute('aria-current', 'page')
    expect(fortymmRow()).not.toHaveAttribute('aria-current')
  })

  it('degrades a mangled ?league= to the default league rather than erroring', async () => {
    // A garbage league is a broken URL, not a broken app. The search schema
    // catches it (`.catch(undefined)`) so it never reaches the wire — which
    // matters: `league_id` is a uuid on the API, so FastAPI would 422 this, and
    // the page would blow up into the error boundary instead of rendering.
    mockLeagueScopedProfile()

    renderProfile('/players/p-1?league=not-a-league')

    // The default league answered, and the page is a page — not an alert.
    await screen.findByText('#3 of 42')
    expect(heroRating()).toHaveTextContent('1687')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // …and the card highlights the ladder those numbers are actually from.
    expect(fortymmRow()).toHaveAttribute('aria-current', 'page')
    expect(usattRow()).not.toHaveAttribute('aria-current')
  })
})

/**
 * The rating chart — the one card on the profile that does not project off the
 * BFF bundle (ADR-0915), and the only one that can fail on its own.
 *
 * Everything below is a claim about **requests and the URL**, which is why it is
 * tested here, at the route, rather than at the card: a range flip is a
 * navigation, and the only honest way to make one is to click the tab and let the
 * router re-render the page with a new `?range=`.
 *
 * Every stub answers **per range** — a stub that returned the same window whatever
 * was asked for would let a chart that never re-fetched, or one that seeded the
 * wrong window into the new tab, pass without a murmur.
 */
const WINDOWS: Record<RatingRange, ReturnType<typeof buildRatingHistoryWindow>> =
  {
    '90d': buildRatingHistoryWindow({ change: 127 }),
    '30d': buildRatingHistoryWindow({
      anchor: buildRatingPoint({ at: daysAgo(40), rating: 1699 }),
      points: [buildRatingPoint({ at: daysAgo(9), rating: 1687 })],
      peak: buildRatingPoint({ at: daysAgo(9), rating: 1687 }),
      change: -12,
    }),
    '1y': buildRatingHistoryWindow({ change: 314 }),
  }

const asRange = (raw: string | null): RatingRange =>
  raw === '30d' || raw === '1y' ? raw : '90d'

/** Stub the bundle (whose embedded window is the chart's seed) and the chart's own
 * endpoint, both answering per range. `onHistory` sees every narrow request the
 * chart makes — the whole point of the card is that there are very few. */
function mockChartProfile({
  onBundle,
  onHistory,
  historyStatus,
}: {
  onBundle?: (range: RatingRange) => void
  onHistory?: (range: RatingRange) => void
  historyStatus?: number
} = {}) {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get('*/v1/players/:playerId', ({ request }) => {
      const range = asRange(new URL(request.url).searchParams.get('range'))
      onBundle?.(range)
      return HttpResponse.json(
        buildPlayerDetail({
          username: 'rita.kovac',
          rating: 1687,
          rating_history: WINDOWS[range],
        }),
      )
    }),
    http.get('*/v1/players/:playerId/rating-history', async ({ request }) => {
      const range = asRange(new URL(request.url).searchParams.get('range'))
      onHistory?.(range)
      if (historyStatus) return new HttpResponse(null, { status: historyStatus })
      // A beat of latency, so a test can catch the card *mid-flip* and see what it
      // is holding on screen while it waits.
      await delay(20)
      return HttpResponse.json(WINDOWS[range])
    }),
  )
}

const chart = ratingChartDisplayPage

describe('player profile — the rating chart', () => {
  it('paints the chart with NO request of its own — the bundle carried the window', async () => {
    // First paint is one request for the whole page, chart included: the bundle
    // embeds the window, and the card seeds its cache from it. A chart that
    // fetched on mount would double the profile's cost on every single view.
    const bundles: RatingRange[] = []
    const histories: RatingRange[] = []
    mockChartProfile({
      onBundle: (r) => bundles.push(r),
      onHistory: (r) => histories.push(r),
    })

    renderProfile()

    await chart.findChartCard()
    expect(chart.getChartSummary()).toBe('Up 127 over the last 90 days')
    expect(chart.queryChartLine()).toBeInTheDocument()
    await waitFor(() => expect(histories).toEqual([]))
    expect(bundles).toEqual(['90d'])
  })

  it('deep-links to ?range=30d in ONE request — the loader asks for the window the URL names', async () => {
    // The loader's `loaderDeps`. Without them it prefetches the *default* window,
    // the cards read that same cache entry, and the chart is handed ninety days of
    // history to draw under a "30d" tab — either seeding it wrongly, or (if it
    // refused) paying for a second request on the very first paint.
    const bundles: RatingRange[] = []
    const histories: RatingRange[] = []
    mockChartProfile({
      onBundle: (r) => bundles.push(r),
      onHistory: (r) => histories.push(r),
    })

    renderProfile('/players/p-1?range=30d')

    await chart.findChartCard()
    // The 30-day window's numbers — not the 90-day window's +127.
    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Down 12 over the last 30 days'),
    )
    expect(chart.getSelectedRangeTab()).toHaveTextContent('30d')
    expect(bundles).toEqual(['30d'])
    await waitFor(() => expect(histories).toEqual([]))
  })

  it('flips range with ONE narrow request, keeps the old line on screen, and puts it in the URL', async () => {
    // The reason this card owns its own query at all. Three things happen at once,
    // and each of them is a separate way for the design to be wrong:
    //   - exactly ONE request goes out, for the range that was clicked;
    //   - the BUNDLE is not refetched (range is deliberately not in its key — if it
    //     were, six other cards would blink back to their skeletons);
    //   - the old line stays up while the new one loads (`keepPreviousData`; a
    //     `useSuspenseQuery` here would blank the card to a skeleton instead).
    const bundles: RatingRange[] = []
    const histories: RatingRange[] = []
    mockChartProfile({
      onBundle: (r) => bundles.push(r),
      onHistory: (r) => histories.push(r),
    })

    const { router } = renderProfile()

    await chart.findChartCard()
    expect(chart.getChartSummary()).toBe('Up 127 over the last 90 days')

    await userEvent.click(chart.getRangeTab('30d'))

    // Mid-flip: the line is still there, and it is still the one we were looking
    // at — busy, not gone.
    expect(chart.queryChartLine()).toBeInTheDocument()
    expect(chart.isChartBusy()).toBe(true)
    // …and the card has stopped quoting the old window's numbers under the new
    // window's name.
    expect(chart.queryChangeChip()).toBeNull()

    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Down 12 over the last 30 days'),
    )
    expect(chart.queryChangeChip()).toHaveTextContent('-12')
    // ONE narrow request, for exactly the range clicked…
    expect(histories).toEqual(['30d'])
    // …and NOT a second bundle. The rest of the profile never moved.
    expect(bundles).toEqual(['90d'])
    expect(heroRating()).toHaveTextContent('1687')
    // …and the selection is in the URL, which is what makes it survive a reload.
    expect(router.state.location.search).toEqual({ range: '30d' })
  })

  it('serves a range you have already seen from cache — no second request', async () => {
    const histories: RatingRange[] = []
    mockChartProfile({ onHistory: (r) => histories.push(r) })

    renderProfile()

    await chart.findChartCard()
    await userEvent.click(chart.getRangeTab('30d'))
    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Down 12 over the last 30 days'),
    )

    await userEvent.click(chart.getRangeTab('90d'))

    // Back to the window the bundle seeded: it is still in the cache, and fresh.
    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Up 127 over the last 90 days'),
    )
    expect(histories).toEqual(['30d'])
  })

  it('fails a range flip INSIDE the card — the rest of the profile stays painted', async () => {
    // The card is the only one on the page that owns an error state, and this is
    // why: the profile loaded fine. One narrow request for one window failed.
    // Throwing that to the route boundary would blank a perfectly good page
    // because somebody clicked "30d".
    mockChartProfile({ historyStatus: 500 })

    renderProfile()

    await chart.findChartCard()
    await userEvent.click(chart.getRangeTab('30d'))

    expect(await chart.findChartError()).toHaveTextContent(
      'Couldn’t load that range',
    )
    // The page around it is untouched: the hero, the career card, the confidence
    // card and the matches are all exactly where they were.
    expect(heroRating()).toHaveTextContent('1687')
    expect(screen.getByText('24 W · 11 L')).toBeInTheDocument()
    expect(screen.getByText('Settled')).toBeInTheDocument()
    expect(screen.queryByText('Couldn’t load this player')).not.toBeInTheDocument()
    // …and the failure is recoverable without leaving the page.
    expect(chart.getRetry()).toBeInTheDocument()
  })

  it('keeps ?range= across a reload — the URL is the state', async () => {
    // A cold load straight at `?range=1y`: what the browser does on F5. If the
    // selection lived in component state, this would come back at 90d.
    mockChartProfile()

    renderProfile('/players/p-1?range=1y')

    await chart.findChartCard()
    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Up 314 over the last year'),
    )
    expect(chart.getSelectedRangeTab()).toHaveTextContent('1y')
  })

  it('degrades a mangled ?range= to the default window rather than erroring', async () => {
    // A garbage range is a broken URL, not a broken app — and it must never reach
    // the wire, where the API's `Literal["30d","90d","1y"]` would 422 it.
    mockChartProfile()

    renderProfile('/players/p-1?range=lol')

    await chart.findChartCard()
    expect(chart.getChartSummary()).toBe('Up 127 over the last 90 days')
    expect(chart.getSelectedRangeTab()).toHaveTextContent('90d')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('gives an unrated player no chart at all — and asks for no history', async () => {
    // Consistent with the hero ("Unrated") and the confidence card (which does not
    // render): there is no rating, so there is no timeline to draw.
    const histories: RatingRange[] = []
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json(buildUnratedPlayerDetail({ username: 'park.j' })),
      ),
      http.get('*/v1/players/:playerId/rating-history', ({ request }) => {
        histories.push(asRange(new URL(request.url).searchParams.get('range')))
        return HttpResponse.json(buildRatingHistoryWindow())
      }),
    )

    renderProfile('/players/p-2')

    expect(
      await screen.findByText(
        'Unrated — finish a rated match to start your rating.',
      ),
    ).toBeInTheDocument()
    expect(chart.queryChartLine()).not.toBeInTheDocument()
    await waitFor(() => expect(histories).toEqual([]))
  })
})

describe('player profile — the chart’s window is the window it says it is', () => {
  it('never draws a REMEMBERED window under another window’s caption', async () => {
    // The hazard this pins is invisible on a single page load, and it is the reason
    // the bundle *seeds the chart from its fetch* rather than the chart seeding
    // itself from the bundle's cache.
    //
    // The bundle's cache key deliberately has no `range` in it — a flip must not
    // re-suspend the six cards that project off it — but the bundle's *contents*
    // very much do: it embeds the window it was asked for. So a bundle cached from
    // an earlier visit carries a window whose range nothing records. A card that
    // read `rating_history` out of that cache to seed itself would take the 30-day
    // window this first visit fetched, file it under "90d" on the second, stamp it
    // fresh — and draw 30 days of history beneath a caption reading "over the last
    // 90 days", with no request left to correct it.
    //
    // Hence: arrive at ?range=30d, leave, and come back at the default range with
    // the bundle still in cache. The line must be the ninety-day one.
    const histories: RatingRange[] = []
    mockChartProfile({ onHistory: (r) => histories.push(r) })

    const first = renderProfile('/players/p-1?range=30d')
    await chart.findChartCard()
    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Down 12 over the last 30 days'),
    )
    first.unmount()

    // Same QueryClient — the bundle (and its 30-day window) is still cached.
    renderProfile('/players/p-1', first.queryClient)

    await chart.findChartCard()
    await waitFor(() =>
      expect(chart.getChartSummary()).toBe('Up 127 over the last 90 days'),
    )
    // Whatever it took to get there, it was never the other window's line: "Down
    // -12 over the last 90 days" is the exact sentence the old seeding produced.
    expect(chart.getChartSummary()).not.toContain('-12')
    // …and it cost at most ONE narrow request to be right (often zero: the bundle's
    // own refetch re-seeds the window it asked for).
    expect(histories.filter((range) => range !== '90d')).toEqual([])
    expect(histories.length).toBeLessThanOrEqual(1)
  })
})
