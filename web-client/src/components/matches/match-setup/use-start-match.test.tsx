import { StrictMode } from 'react'
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
  // Mount under StrictMode so the effect double-invoke (mount→cleanup→remount)
  // the real app (src/main.tsx) exercises is reproduced here — a cleanup-only
  // mounted-ref would latch false and permanently suppress the redirect, and
  // this harness is where that must be caught (#810).
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
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

    await act(() => submit({ selection: { kind: 'none' }, bestOf: 5, rated: false }))

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
      submit({ selection: { kind: 'none' }, bestOf: 5, rated: false })
      submit({ selection: { kind: 'none' }, bestOf: 5, rated: false })
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
      submitPromise = submit({ selection: { kind: 'none' }, bestOf: 5, rated: false })
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

  it('leaves a spent instance behind: an old in-flight create resolving after the user left does not redirect, and a freshly-mounted form still creates + redirects', async () => {
    // One handler serves both hooks (server.use is reset per test): the FIRST
    // create (instance 1) is held open so the user can leave mid-flight; the
    // SECOND (instance 2, the fresh form) resolves immediately so it can prove
    // it still redirects. Both return a fully valid MatchDetails so each passes
    // the network Zod parse and reaches the (gated) redirect branch.
    let postCount = 0
    let releasePost: () => void = () => {}
    const postReleased = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    server.use(
      http.post('*/v1/matches', async () => {
        postCount += 1
        if (postCount === 1) await postReleased
        const seed = newMatchSeed({ bestOf: 5, rated: false, opponent: null })
        return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
      }),
    )

    // Instance 1: fire the create (holding its promise so we can drain the full
    // success branch later), then navigate away — unmounting the Probe/hook —
    // while the POST is still in flight.
    const hook1 = renderStartMatch()
    const { submit: submit1 } = await hook1.ready()
    let submit1Promise: unknown
    act(() => {
      submit1Promise = submit1({ selection: { kind: 'none' }, bestOf: 5, rated: false })
    })
    await act(async () => {
      await hook1.router.navigate({
        to: '/matches/$matchId',
        params: { matchId: 'left-behind' },
      })
    })
    // Pin the ordering: instance 1's request must be the held call #1 before
    // instance 2 submits, so its own (immediate) create is call #2.
    await waitFor(() => expect(postCount).toBe(1))

    // Instance 2: an independent, freshly-mounted form. Its create resolves
    // immediately and MUST redirect to scoring — proving the fresh instance is
    // not latched by anything the spent instance 1 left behind.
    const hook2 = renderStartMatch()
    const { submit: submit2 } = await hook2.ready()
    await act(() => submit2({ selection: { kind: 'none' }, bestOf: 5, rated: false }))
    expect(hook2.router.state.location.pathname).toMatch(
      /^\/matches\/.+\/games\/1\/scores\/new$/,
    )

    // Now release instance 1's stale create and drain its success branch.
    await act(async () => {
      releasePost()
      await submit1Promise
      await new Promise((r) => setTimeout(r, 0))
    })

    // Instance 1's router stayed exactly where the user left it — releasing the
    // stale create did not yank it to the new match's scoring page. On the
    // pre-fix hook this pathname is the scoring route, so the exact-match is the
    // red signal (strictly stronger than "not scoring").
    expect(hook1.router.state.location.pathname).toBe('/matches/left-behind')
    // Both creates ran to completion — background-complete, never aborted.
    expect(postCount).toBe(2)
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
      submit({
        selection: { kind: 'picked', opponent: buildOpponent() },
        bestOf: 5,
        rated: true,
      }),
    )

    const result = await hook.ready()
    expect(result.apiError).toBe('Could not start the match right now.')
  })

  it('sends a seeking selection as a solo, unrated match — an uncommitted query is not an opponent (#893)', async () => {
    // The send-time coercion is one of the places that has to agree on what a
    // half-typed search means: nothing. It coerces exactly like `none` — no
    // opponent id invented from the query, no rating.
    let captured: unknown = null
    server.use(
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        const seed = newMatchSeed({ bestOf: 5, rated: false, opponent: null })
        return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
      }),
    )
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    await act(() =>
      submit({
        selection: { kind: 'seeking' },
        bestOf: 5,
        rated: false,
      }),
    )

    expect(captured).toEqual({
      opponent_user_id: null,
      best_of: 5,
      rated: false,
    })
  })

  it('refuses to create a rated match from a seeking selection, exactly as from none (#893)', async () => {
    // Defense in depth, and the schema's half of "a seeking match is unrated":
    // if a stale `rated: true` ever reached submit while the user was still
    // searching, the refinement rejects it inline rather than POSTing a rated
    // match with no opponent.
    let posts = 0
    server.use(
      http.post('*/v1/matches', () => {
        posts += 1
        return HttpResponse.json({}, { status: 201 })
      }),
    )
    const hook = renderStartMatch()
    const { submit } = await hook.ready()

    await act(() =>
      submit({
        selection: { kind: 'seeking' },
        bestOf: 5,
        rated: true,
      }),
    )

    const result = await hook.ready()
    expect(result.apiError).toMatch(/rated match needs an opponent/i)
    expect(posts).toBe(0)
  })
})
