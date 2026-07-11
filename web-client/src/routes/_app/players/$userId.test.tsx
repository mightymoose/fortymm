import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { PlayerDetail } from '@/api/players'
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
import { ratingPanelDisplayPage } from '@/components/players/player-profile/rating-panel/rating-panel-fetcher/rating-panel-display.page'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { Route } from './$userId'

const ProfileRoute = Route.options.component!
const ProfileError = Route.options.errorComponent!

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

function renderProfile(initialEntry = '/players/p-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId',
    component: ProfileRoute,
    errorComponent: ProfileError,
    validateSearch: Route.options.validateSearch,
  })
  // The Recent matches card's footer is a typed <Link> to the full history, so
  // the route it opens must be registered for the link to resolve.
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId/matches',
    component: () => <div>match history</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([profileRoute, historyRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  // The router comes back so a test can read the URL the page navigated to — the
  // league selection IS the URL (ADR-0915), so "it went into the URL" is a claim
  // that has to be checked against the real thing, not against a rendered class.
  return { ...render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ), router }
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
