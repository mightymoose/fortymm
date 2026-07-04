import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import {
  QueryClient,
  QueryClientProvider,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Suspense } from 'react'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import { matchDetails, sessionResponse } from '@/test/factories'
import { matchDetailsQuery } from '@/components/matches/match-details/match-details-query'
import { api } from '@/api/client'
import { Route } from './new'

// The page component isn't exported (route files should only export `Route`,
// so the router plugin can code-split them) — pull it off the route instead.
const NewMatchPage = Route.options.component!

function pendingMatch() {
  return matchDetails({
    id: 'm-test',
    games: [],
    current_game: { game_number: 1 },
  })
}

function renderNewMatch() {
  const queryClient = new QueryClient({
    // Mirror the app's real client (`main.tsx`): a 30s staleTime is what keeps
    // a freshly-primed match-details entry from being treated as stale and
    // background-refetched the instant the page mounts (#510).
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  })
  const rootRoute = createRootRoute()
  const newMatchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/new',
    component: NewMatchPage,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard route</div>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>Settings route</div>,
  })
  const scoringRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: () => {
      const { matchId, gameNumber } = scoringRoute.useParams()
      return <div>Scoring route {matchId} game {gameNumber}</div>
    },
  })
  // A stand-in for the real match-details page: it reads the same query the
  // page does, so it renders from a primed cache and only hits the network on
  // a cache miss.
  const detailsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => {
      const { matchId } = detailsRoute.useParams()
      return (
        <Suspense fallback={<div>Loading match…</div>}>
          <DetailsProbe matchId={matchId} />
        </Suspense>
      )
    },
  })
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div>Login route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      newMatchRoute,
      dashboardRoute,
      settingsRoute,
      scoringRoute,
      detailsRoute,
      loginRoute,
    ]),
    history: createMemoryHistory({
      // Seed a prior entry (the dashboard) so a Back from score entry has
      // somewhere real to land — and the new-match form must not be it.
      initialEntries: ['/dashboard', '/matches/new'],
      initialIndex: 1,
    }),
  })
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

function DetailsProbe({ matchId }: { matchId: string }) {
  const { data } = useSuspenseQuery(matchDetailsQuery(matchId))
  return (
    <div>
      Details route {matchId} status {data.data.scoreboard.status}
    </div>
  )
}

describe('NewMatchPage', () => {
  it('creates a match against a picked opponent and navigates to the scoring page', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([
          { id: 'pl-1', username: 'ada.lovelace' },
          { id: 'pl-2', username: 'grace.hopper' },
        ]),
      ),
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    // Picking an opponent unlocks the Rated toggle; turn it on so the match
    // is submitted as rated.
    await user.click(screen.getByRole('switch', { name: /rated match/i }))
    await user.click(screen.getByRole('button', { name: /start match/i }))

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    expect(captured).toEqual({
      opponent_user_id: 'pl-1',
      best_of: 5,
      rated: true,
    })
  })

  it('replaces the new-match form in history so Back from scoring does not re-open it (#441)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () => HttpResponse.json([])),
      http.post('*/v1/matches', () =>
        HttpResponse.json(pendingMatch(), { status: 201 }),
      ),
    )
    const { router } = renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )
    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )

    // Going Back must NOT return to the creation form (which would otherwise
    // try to re-create the match) — it lands on the page before it.
    router.history.back()
    await waitFor(() =>
      expect(screen.getByText('Dashboard route')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: /start match/i }),
    ).not.toBeInTheDocument()
  })

  it('seeds the details cache from the create response, so a redirect to /matches/{id} renders without the racing GET (#510)', async () => {
    const user = userEvent.setup()
    // A match with no next game redirects straight to /matches/{id} rather than
    // the scoring page — the exact path that hit the read-after-write 404.
    const created = matchDetails({
      id: 'm-test',
      current_game: null,
      data: { scoreboard: { status: 'final' } },
    })
    let detailsGetCalls = 0
    server.use(
      http.get('*/v1/players/recent', () => HttpResponse.json([])),
      http.post('*/v1/matches', () =>
        HttpResponse.json(created, { status: 201 }),
      ),
      // Stand in for the race: the just-created match still 404s if the page
      // actually fetches it. The primed cache must make this unreachable.
      http.get('*/v1/matches/:id', () => {
        detailsGetCalls += 1
        return HttpResponse.json({ detail: 'Match not found.' }, { status: 404 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )

    // The details page renders from the seeded cache — no "couldn't find that
    // match" dead-end — and never touched the network.
    expect(
      await screen.findByText('Details route m-test status final'),
    ).toBeInTheDocument()
    expect(detailsGetCalls).toBe(0)
  })

  it('starts a single-sided unrated match when no opponent is chosen', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    // No opponent picked, no toggle flipped — Start match submits a solo,
    // unrated match (the form defaults Rated off for this reason).
    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    expect(captured).toEqual({
      opponent_user_id: null,
      best_of: 5,
      rated: false,
    })
  })

  it('resets Rated to off when the opponent is cleared, so re-picking does not silently re-engage rating', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([
          { id: 'pl-1', username: 'ada.lovelace' },
          { id: 'pl-2', username: 'grace.hopper' },
        ]),
      ),
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    // Pick Ada and turn Rated on.
    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    const ratedSwitch = () =>
      screen.getByRole('switch', { name: /rated match/i })
    await user.click(ratedSwitch())
    expect(ratedSwitch()).toHaveAttribute('aria-checked', 'true')

    // Unpick Ada — clearing the opponent must also clear the rated state, so
    // re-picking doesn't quietly submit a rated match the user didn't ask for.
    await user.click(screen.getByRole('button', { name: /^change$/i }))
    await user.click(screen.getByRole('button', { name: /grace\.hopper/i }))
    expect(ratedSwitch()).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('button', { name: /start match/i }))
    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    expect(captured).toEqual({
      opponent_user_id: 'pl-2',
      best_of: 5,
      rated: false,
    })
  })

  it('shows the rating on the selected-opponent card for a rated player, matching the picker', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([
          { id: 'pl-1', username: 'ada.lovelace', rating: 1662 },
        ]),
      ),
    )
    renderNewMatch()

    // The recent chip already reads its rating; picking it must carry that
    // rating through to the selected-opponent card rather than falling back to
    // the generic "REGISTERED PLAYER" label.
    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    const selected = screen.getByRole('button', { name: /^change$/i })
      .parentElement!
    expect(selected).toHaveTextContent(/RATING 1662/)
    expect(selected).not.toHaveTextContent(/REGISTERED PLAYER/)
  })

  it('falls back to the generic label on the selected card for an unrated player', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    expect(
      screen.getByRole('button', { name: /^change$/i }).parentElement!,
    ).toHaveTextContent(/REGISTERED PLAYER/)
  })

  it('surfaces the API error detail when match creation fails', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
      ),
      http.post('*/v1/matches', () =>
        HttpResponse.json({ detail: 'opponent not found' }, { status: 404 }),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /opponent not found/i,
    )
  })

  it('does not fire a duplicate create on a second click while one is in flight (#81)', async () => {
    const user = userEvent.setup()
    let posts = 0
    server.use(
      http.get('*/v1/players/recent', () => HttpResponse.json([])),
      http.post('*/v1/matches', async () => {
        posts += 1
        await delay(20)
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )
    // The button is now in its disabled "Starting…" state; a second click must
    // not start a second match.
    await user.click(screen.getByRole('button', { name: /starting/i }))

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    expect(posts).toBe(1)
  })

  it('navigates away immediately on Cancel when the form is untouched', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/v1/players/recent', () => HttpResponse.json([])))
    renderNewMatch()

    await user.click(await screen.findByRole('button', { name: /^cancel$/i }))

    await waitFor(() =>
      expect(screen.getByText('Dashboard route')).toBeInTheDocument(),
    )
  })

  it('confirms before discarding a dirty form on Cancel (#75)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    // A confirmation gates the navigation — the form is still up, not the
    // dashboard.
    expect(
      await screen.findByRole('alertdialog', { name: /discard changes/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Dashboard route')).not.toBeInTheDocument()

    // "Keep editing" dismisses the dialog without navigating.
    await user.click(screen.getByRole('button', { name: /keep editing/i }))
    expect(
      screen.queryByRole('alertdialog', { name: /discard changes/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^change$/i })).toBeInTheDocument()

    // Confirming discards the form and navigates away.
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await user.click(
      await screen.findByRole('button', { name: /discard.*leave/i }),
    )
    await waitFor(() =>
      expect(screen.getByText('Dashboard route')).toBeInTheDocument(),
    )
  })

  it('does not block the post-create redirect for a dirty (rated, opponent-picked) form', async () => {
    // Regression: the dirty-form blocker's `shouldBlockFn` must not catch the
    // in-app navigate() a successful Start match fires — the form is still
    // "dirty" (opponent picked, Rated on) at that instant, so without the
    // `hasSucceeded()` escape hatch this redirect would incorrectly pop the
    // "Discard changes?" dialog instead of landing on the scoring page.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
      ),
      http.post('*/v1/matches', () =>
        HttpResponse.json(pendingMatch(), { status: 201 }),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('switch', { name: /rated match/i }))
    await user.click(screen.getByRole('button', { name: /start match/i }))

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('alertdialog', { name: /discard changes/i }),
    ).not.toBeInTheDocument()
  })

  it('shows a wait cursor on the Start match button while submitting (#77)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () => HttpResponse.json([])),
      http.post('*/v1/matches', async () => {
        await delay(20)
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )

    const pendingButton = screen.getByRole('button', { name: /starting/i })
    expect(pendingButton).toHaveClass('nm-btn-pending')
    expect(
      pendingButton.querySelector('.fmm-icon-spin'),
    ).toBeInTheDocument()

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
  })

  it('surfaces a timeout error and re-enables the button when the create aborts (#76)', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/v1/players/recent', () => HttpResponse.json([])))
    // A hung POST is aborted by the hook's `AbortSignal.timeout`, which rejects
    // the fetch with a `TimeoutError` DOMException rather than an HTTP error
    // result. Stand in for that rejection directly — deterministic, no waiting
    // out the real 15s timeout — and assert the hook translates it into the
    // inline "timed out" message with the button no longer stuck on "Starting…".
    const post = vi
      .spyOn(api, 'POST')
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    try {
      renderNewMatch()

      await user.click(
        await screen.findByRole('button', { name: /start match/i }),
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(/timed out/i)
      expect(
        screen.getByRole('button', { name: /start match/i }),
      ).toBeEnabled()
    } finally {
      post.mockRestore()
    }
  })
})

describe('NewMatchPage — match-length keyboard (#64)', () => {
  // The match-length radiogroup must be operable from the keyboard per
  // WCAG 2.1.1: it is a single Tab stop (roving tabindex) and arrows/Home/End
  // move *and* select between options.
  function recentEmpty() {
    return http.get('*/v1/players/recent', () => HttpResponse.json([]))
  }

  function lengthRadios() {
    return screen
      .getByRole('radiogroup', { name: /match length/i })
      .querySelectorAll<HTMLButtonElement>('[role="radio"]')
  }

  it('exposes the group as a single Tab stop via roving tabindex', async () => {
    server.use(recentEmpty())
    renderNewMatch()
    await screen.findByRole('radiogroup', { name: /match length/i })

    const radios = lengthRadios()
    // Default is Best of 5 ("Std"), the third option — only it is tabbable.
    expect(Array.from(radios).map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1])
  })

  it('moves and selects with ArrowRight/ArrowLeft, wrapping at the ends', async () => {
    const user = userEvent.setup()
    server.use(recentEmpty())
    renderNewMatch()
    await screen.findByRole('radiogroup', { name: /match length/i })

    const [single, , std, long] = Array.from(lengthRadios())
    std.focus()
    expect(std).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(long).toHaveAttribute('aria-checked', 'true')
    expect(long).toHaveFocus()

    // Wrap forward off the last option back to the first.
    await user.keyboard('{ArrowRight}')
    expect(single).toHaveAttribute('aria-checked', 'true')
    expect(single).toHaveFocus()

    // Wrap backward off the first option to the last.
    await user.keyboard('{ArrowLeft}')
    expect(long).toHaveAttribute('aria-checked', 'true')
    expect(long).toHaveFocus()
  })

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup()
    server.use(recentEmpty())
    renderNewMatch()
    await screen.findByRole('radiogroup', { name: /match length/i })

    const radios = Array.from(lengthRadios())
    const first = radios[0]
    const last = radios[radios.length - 1]
    radios[2].focus()

    await user.keyboard('{Home}')
    expect(first).toHaveAttribute('aria-checked', 'true')
    expect(first).toHaveFocus()

    await user.keyboard('{End}')
    expect(last).toHaveAttribute('aria-checked', 'true')
    expect(last).toHaveFocus()
  })
})

describe('NewMatchPage — recent opponents', () => {
  it('shows a skeleton while recent opponents load, then the chips', async () => {
    server.use(
      http.get('*/v1/players/recent', async () => {
        await delay(80)
        return HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }])
      }),
    )
    renderNewMatch()

    // The placeholder grid is up while the request is in flight.
    expect(
      await screen.findByRole('status', { name: /loading players/i }),
    ).toBeInTheDocument()

    // ...then the real chip replaces it.
    expect(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('status', { name: /loading players/i }),
    ).not.toBeInTheDocument()
  })

  it('waits for the session before requesting recent opponents (no first-visit 401 race)', async () => {
    const recentRequests: string[] = []
    let releaseSession: (() => void) | null = null
    server.use(
      // Hold the session request open to simulate the cookie not having
      // landed yet on a first-visit direct-load (#98).
      http.get('*/v1/session', async () => {
        await new Promise<void>((resolve) => {
          releaseSession = resolve
        })
        return HttpResponse.json(sessionResponse())
      }),
      http.get('*/v1/players/recent', ({ request }) => {
        recentRequests.push(request.url)
        return HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }])
      }),
    )
    renderNewMatch()

    // While the session is unresolved the query is disabled: the skeleton
    // holds and no players request is fired (so it can't 401).
    expect(
      await screen.findByRole('status', { name: /loading players/i }),
    ).toBeInTheDocument()
    await waitFor(() => expect(releaseSession).not.toBeNull())
    expect(recentRequests).toHaveLength(0)

    // Once the session resolves, the query runs and the real chips render.
    releaseSession!()
    expect(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    ).toBeInTheDocument()
    expect(recentRequests.length).toBeGreaterThanOrEqual(1)
  })

  it('renders recent opponents in the order the endpoint returns them', async () => {
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([
          { id: 'pl-3', username: 'carol.recent' },
          { id: 'pl-1', username: 'alice.older' },
          { id: 'pl-2', username: 'bob.oldest' },
        ]),
      ),
    )
    const { container } = renderNewMatch()

    await screen.findByRole('button', { name: /carol\.recent/i })
    const names = [...container.querySelectorAll('.nm-chip .n')].map(
      (node) => node.textContent,
    )
    // Most-recently-played first — the client preserves the endpoint's order.
    expect(names).toEqual(['carol.recent', 'alice.older', 'bob.oldest'])
  })

  it('shows an empty state but keeps search when the caller has no opponents yet (#167)', async () => {
    server.use(http.get('*/v1/players/recent', () => HttpResponse.json([])))
    renderNewMatch()

    expect(
      await screen.findByText(/no opponents yet/i),
    ).toBeInTheDocument()
    // The empty grid no longer means an empty roster — search is the way to
    // find a first opponent, so it stays available.
    expect(
      screen.getByRole('button', { name: /search all players/i }),
    ).toBeInTheDocument()
  })

  it('shows a retry button when recent opponents fail to load, and recovers', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get('*/v1/players/recent', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            { detail: 'database unavailable' },
            { status: 500 },
          )
        }
        return HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }])
      }),
    )
    renderNewMatch()

    // The picker boundary catches the failed load and offers a retry.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn.t load players/i,
    )

    await user.click(screen.getByRole('button', { name: /try again/i }))

    // The retried request succeeds and the picker renders normally.
    expect(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    ).toBeInTheDocument()
  })
})

describe('NewMatchPage — rated guest hint', () => {
  function recentWithOne() {
    return http.get('*/v1/players/recent', () =>
      HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
    )
  }

  it('shows a tip linking to the email settings when a guest flips Rated on', async () => {
    const user = userEvent.setup()
    server.use(recentWithOne())
    renderNewMatch()

    // No hint before the toggle is engaged — the moment of opt-in is the
    // trigger, not page load.
    await screen.findByRole('button', { name: /ada\.lovelace/i })
    expect(screen.queryByRole('link', { name: /add an email/i })).toBeNull()

    await user.click(screen.getByRole('button', { name: /ada\.lovelace/i }))
    await user.click(screen.getByRole('switch', { name: /rated match/i }))

    const link = await screen.findByRole('link', { name: /add an email/i })
    expect(link).toHaveAttribute('href', '/settings#sec-email')
  })

  it('hides the tip again when Rated is toggled off', async () => {
    const user = userEvent.setup()
    server.use(recentWithOne())
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    const ratedSwitch = screen.getByRole('switch', { name: /rated match/i })
    await user.click(ratedSwitch)
    expect(
      await screen.findByRole('link', { name: /add an email/i }),
    ).toBeInTheDocument()

    await user.click(ratedSwitch)
    expect(screen.queryByRole('link', { name: /add an email/i })).toBeNull()
  })

  it('does not show the tip for a user with a confirmed email', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(
          sessionResponse({
            user: {
              email: 'rita@example.com',
              confirmed_at: '2026-01-01T00:00:00Z',
            },
          }),
        ),
      ),
      recentWithOne(),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('switch', { name: /rated match/i }))

    // The toggle is on, but the rating-durability question doesn't apply.
    expect(
      screen.getByRole('switch', { name: /rated match/i }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('link', { name: /add an email/i })).toBeNull()
  })
})

describe('NewMatchPage — opponent search', () => {
  function recentWithOne() {
    return http.get('*/v1/players/recent', () =>
      HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
    )
  }

  it('hits the dedicated search endpoint as the player types', async () => {
    const user = userEvent.setup()
    const queries: string[] = []
    server.use(
      recentWithOne(),
      http.get('*/v1/players/search', ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('q') ?? '')
        return HttpResponse.json([
          { id: 'pl-9', username: 'barbara.liskov' },
        ])
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /search all players/i }),
    )
    await user.type(
      screen.getByPlaceholderText(/search by username/i),
      'liskov',
    )

    // The server-side result is selectable straight from the dropdown.
    await user.click(
      await screen.findByRole('option', { name: /barbara\.liskov/i }),
    )
    expect(screen.getByText(/registered player/i)).toBeInTheDocument()
    // The query reached the endpoint — nothing was filtered client-side.
    expect(queries.at(-1)).toBe('liskov')
  })

  it('shows a hint before typing and a no-match message for an unknown name', async () => {
    const user = userEvent.setup()
    server.use(
      recentWithOne(),
      http.get('*/v1/players/search', () => HttpResponse.json([])),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /search all players/i }),
    )
    expect(screen.getByText(/start typing to search/i)).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/search by username/i),
      'nobody-here',
    )
    expect(await screen.findByText(/no one matches/i)).toBeInTheDocument()
  })

  it('catches a failed search in the picker error boundary', async () => {
    const user = userEvent.setup()
    server.use(
      recentWithOne(),
      http.get('*/v1/players/search', () =>
        HttpResponse.json({ detail: 'search unavailable' }, { status: 500 }),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /search all players/i }),
    )
    await user.type(
      screen.getByPlaceholderText(/search by username/i),
      'ada',
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn.t load players/i,
    )
  })
})

describe('NewMatchPage — mobile label layout (#388)', () => {
  // These guard the DOM contract the responsive CSS in new.css relies on to
  // keep labels and captions from crowding on a 375px screen. jsdom doesn't
  // lay out, so we assert structure rather than measure pixels: the section
  // head keeps the title and hint as two separate elements (so the flex
  // `gap` / mobile column-stack apply between them, instead of one fused
  // "OpponentOPTIONAL…" text node), and the unavailable caption stays a child
  // of the field label (so its `margin-left:auto`/`padding-left` breathing
  // room and the label's `flex-wrap` keep it off the "Rated match" label).
  function recentWithOne() {
    return http.get('*/v1/players/recent', () =>
      HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
    )
  }

  it('renders the opponent title and hint as separate section-head children', async () => {
    server.use(recentWithOne())
    const { container } = renderNewMatch()

    await screen.findByRole('button', { name: /ada\.lovelace/i })

    const head = container.querySelector('.nm-section-head')
    expect(head).not.toBeNull()
    const title = head!.querySelector('.title')
    const hint = head!.querySelector('.hint')
    expect(title).toHaveTextContent(/^Opponent$/)
    // The hint is its own element — not concatenated into the title — so the
    // gap/column-stack rules have two boxes to space apart.
    expect(hint).not.toBeNull()
    expect(hint).not.toBe(title)
    expect(hint).toHaveTextContent(/optional/i)
  })

  it('keeps the "unavailable" caption inside the rated field label', async () => {
    server.use(recentWithOne())
    const { container } = renderNewMatch()

    // No opponent picked yet → the rated control is unavailable and shows the
    // "No opponent · unavailable" caption.
    await screen.findByRole('button', { name: /ada\.lovelace/i })

    const fieldLabels = container.querySelectorAll('.nm-field-label')
    const na = container.querySelector('.nm-field-label .na')
    expect(na).not.toBeNull()
    expect(na).toHaveTextContent(/no opponent.*unavailable/i)
    // It lives within a field label that also carries the "Rated match" text,
    // so the label's flex layout (wrap + margin) governs both.
    const owner = Array.from(fieldLabels).find((el) => el.contains(na!))
    expect(owner).toBeDefined()
    expect(owner).toHaveTextContent(/rated match/i)
  })
})
