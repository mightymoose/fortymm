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

  it('surfaces a 401 as a session-expired recovery, not a bare error', async () => {
    server.use(
      http.post('*/v1/matches', () =>
        HttpResponse.json(
          { detail: 'Your session has expired.' },
          { status: 401 },
        ),
      ),
    )
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    await act(() =>
      submit({ opponent: buildOpponent(), bestOf: 5, rated: true }),
    )

    const result = await hook.ready()
    expect(result.sessionExpired).toBe(true)
    expect(result.apiError).toBe('Your session has expired.')
  })
})
