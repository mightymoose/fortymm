import { act, render, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import { newMatchSeed, projectMatchDetails } from '@/mocks/match-store'

import { useStartMatch } from './use-start-match'
import { buildOpponent } from './selected-opponent.factory'

// `useStartMatch` calls `useNavigate`, which needs a real router context, so
// this harness mounts the hook under a minimal router (not the plain
// QueryClient-only wrapper from `@/test/utilities`) with stub destinations for
// every route the hook can navigate to. The router resolves its initial match
// asynchronously, so callers must await `ready()` before using `current`.
function renderStartMatch() {
  let hookResult: ReturnType<typeof useStartMatch> | undefined
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  function Probe() {
    hookResult = useStartMatch()
    return null
  }
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: Probe,
  })
  const scoringRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: () => <div>scoring</div>,
  })
  const matchDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <div>match detail</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      scoringRoute,
      matchDetailRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return {
    async ready() {
      await waitFor(() => expect(hookResult).toBeDefined())
      return hookResult!
    },
    router,
  }
}

describe('useStartMatch', () => {
  it('creates the match and navigates to scoring on success', async () => {
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    await act(() => submit({ opponent: null, bestOf: 5, rated: false }))

    expect(hook.router.state.location.pathname).toMatch(
      /^\/matches\/.+\/games\/1\/scores\/new$/,
    )
  })

  it('refuses a double-submit and only creates one match', async () => {
    let postCount = 0
    server.use(
      http.post('*/v1/matches', async () => {
        postCount += 1
        return HttpResponse.json(
          {
            id: 'm-double',
            best_of: 5,
            affects_rating: false,
            status: 'in_progress',
            created_at: new Date(0).toISOString(),
            completed_at: null,
            current_game: { game_number: 1 },
            opponent: null,
            games: [],
            results: [],
          },
          { status: 201 },
        )
      }),
    )
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    await act(async () => {
      submit({ opponent: null, bestOf: 5, rated: false })
      submit({ opponent: null, bestOf: 5, rated: false })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(postCount).toBe(1)
  })

  it('does not redirect to scoring if the user navigated away mid-create', async () => {
    // Hold the POST open so the create is still in flight when the user leaves.
    let postCount = 0
    let releasePost: () => void = () => {}
    const postReleased = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    server.use(
      http.post('*/v1/matches', async () => {
        postCount += 1
        // Hold the create open so the component can unmount mid-flight, then
        // return a *fully valid* MatchDetails payload (built with the same mock
        // helpers the default handler uses) so it passes the network Zod parse
        // and the pre-fix hook actually reaches its unconditional redirect —
        // otherwise the create would reject and mask the bug this test guards.
        await postReleased
        const seed = newMatchSeed({ bestOf: 5, rated: false, opponent: null })
        return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
      }),
    )
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    // Fire the create (capture its promise so we can await the full success
    // branch, incl. the redirect the pre-fix hook would fire), then navigate
    // away (unmounting the Probe/hook) before the create resolves.
    let submitPromise: unknown
    act(() => {
      submitPromise = submit({ opponent: null, bestOf: 5, rated: false })
    })
    await act(async () => {
      await hook.router.navigate({
        to: '/matches/$matchId',
        params: { matchId: 'somewhere-else' },
      })
    })

    // Now let the in-flight create resolve and drain the success branch.
    await act(async () => {
      releasePost()
      await submitPromise
      await new Promise((r) => setTimeout(r, 0))
    })

    // (a) No forced redirect back to scoring — the user's navigation stands.
    // The exact-match is strictly stronger than "not the scoring route": on the
    // pre-fix hook this is the scoring path, so this assertion is the red signal.
    expect(hook.router.state.location.pathname).toBe('/matches/somewhere-else')
    // (b) The create still ran to completion (background-complete, not aborted).
    expect(postCount).toBe(1)
  })

  it('surfaces a server error through apiError', async () => {
    // A lapsed session is a `session_ended` 401 that the global middleware
    // catches and redirects to `/login` (covered in api/client.test.ts) — the
    // hook has no session-specific branch of its own; every other failure just
    // surfaces inline.
    server.use(
      http.post('*/v1/matches', () =>
        HttpResponse.json(
          { detail: 'Could not start the match right now.' },
          { status: 500 },
        ),
      ),
    )
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    await act(() =>
      submit({ opponent: buildOpponent(), bestOf: 5, rated: true }),
    )

    const result = await hook.ready()
    expect(result.apiError).toBe('Could not start the match right now.')
  })
})
