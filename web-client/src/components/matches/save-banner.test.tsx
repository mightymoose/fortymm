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
  useQueryClient,
} from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { matchDetails } from '@/test/factories'
import { fireScoreSave, useProposeResult } from '@/api/matches'
import { SaveBanner } from './save-banner'

// Bo5, 1-1 on the board, game 3 next — a single game-3 failure can't decide the
// match, so the banner stays in its plain "Game N didn't save." mode (not the
// finalize variant) and exposes a Dismiss + Retry.
const inProgressMatch = matchDetails({
  id: 'm-1',
  status: 'in_progress',
  status_label: 'Live',
  best_of: 5,
  games_to_win: 3,
  affects_rating: true,
  games: [
    {
      id: 'g-1',
      game_number: 1,
      score: {
        id: 's-1',
        side_1_points: 11,
        side_2_points: 8,
        winner_side_number: 1,
        version: 1,
      },
    },
    {
      id: 'g-2',
      game_number: 2,
      score: {
        id: 's-2',
        side_1_points: 9,
        side_2_points: 11,
        winner_side_number: 2,
        version: 1,
      },
    },
  ],
  current_game: { game_number: 3 },
  can_score: true,
  can_finalize: false,
})

// Mounts the banner with `activeGameNumber` active and a sibling button that
// imperatively fails `failGameNumber`'s scratch save — the same `fireScoreSave`
// the banner's own Retry calls — so a (re-)failure happens WITHOUT unmounting
// the banner. Keep the failing game distinct from the active one where the test
// needs the failure surfaced (the active game's own failure is suppressed).
function renderBanner({
  failGameNumber,
  activeGameNumber,
}: {
  failGameNumber: number
  activeGameNumber: number
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: function Harness() {
      const qc = useQueryClient()
      const proposeMutation = useProposeResult('m-1')
      return (
        <>
          <button
            type="button"
            onClick={() =>
              fireScoreSave(qc, 'm-1', failGameNumber, {
                side_1_points: 11,
                side_2_points: 4,
              })
            }
          >
            fail game {failGameNumber}
          </button>
          <SaveBanner
            matchId="m-1"
            activeGameNumber={activeGameNumber}
            proposeMutation={proposeMutation}
          />
        </>
      )
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

// #755 scenario. Bo3, game 2 cleanly persisted (side 1 won it), game 1's save
// failed offline (side 1 won it too). The real board is 2-0 for side 1 — a
// decided match — but the user is sitting on game 2's edit screen
// (`activeGameNumber={2}`). The banner must include the cleanly-persisted active
// game 2 in its merged board so it reads the match as decided.
const decidedActivePersistedMatch = matchDetails({
  id: 'm-1',
  status: 'in_progress',
  status_label: 'Live',
  best_of: 3,
  affects_rating: true,
  games: [
    {
      id: 'g-2',
      game_number: 2,
      score: {
        id: 's-2',
        side_1_points: 11,
        side_2_points: 5,
        winner_side_number: 1,
        version: 1,
      },
    },
  ],
  current_game: { game_number: 2 },
  can_score: true,
  can_finalize: false,
})

describe('SaveBanner', () => {
  // Regression for #528: the dismiss key folded only the failed game NUMBERS,
  // so a same-game repeat failure (set still {3}) kept the signature unchanged
  // and the dismissed banner stayed hidden — hiding the new failure. The key
  // now also carries each failure's `submittedAt`, so a fresh failure of an
  // already-listed game re-surfaces the banner.
  it('re-surfaces after dismiss when the same single game fails to save again', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch)),
      // Every game-3 save fails.
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderBanner({ failGameNumber: 3, activeGameNumber: 4 })

    // First failure → banner surfaces.
    await user.click(await screen.findByRole('button', { name: 'fail game 3' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Game 3 didn't save.",
    )

    // Dismiss it.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Same game fails AGAIN (the banner never unmounted). The failed set is
    // unchanged ({3}); only the new failure's identity differs — and that must
    // be enough to bring the dismissed banner back.
    await user.click(screen.getByRole('button', { name: 'fail game 3' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        "Game 3 didn't save.",
      ),
    )
  })

  // #755: a cleanly-persisted active game was dropped from the merged board, so
  // the deciding board read as undecided and the finalize CTA hid behind the
  // unrelated failed game's "Game 1 didn't save." retry.
  it('shows the finalize CTA when a cleanly-persisted active game completes the board', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(decidedActivePersistedMatch),
      ),
      http.post('*/v1/matches/m-1/games/1/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderBanner({ failGameNumber: 1, activeGameNumber: 2 })

    await user.click(await screen.findByRole('button', { name: 'fail game 1' }))

    const alert = await screen.findByRole('alert')
    await waitFor(() =>
      expect(alert).toHaveTextContent('These scores finish the match.'),
    )
    expect(alert).toHaveTextContent(
      "Post the result now — they didn't save individually, but the match is decided.",
    )
    expect(
      screen.getByRole('button', { name: /Post result/ }),
    ).toBeInTheDocument()
    expect(alert).not.toHaveTextContent("Game 1 didn't save.")
  })

  // The finalize action must post the compacted decided board — the failed
  // game 1 (11-4) plus the persisted active game 2 (11-5) — not the older
  // per-game scratch saves.
  it('posts the compacted decided board when Post result is clicked', async () => {
    const user = userEvent.setup()
    let postedBody: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(decidedActivePersistedMatch),
      ),
      http.post('*/v1/matches/m-1/games/1/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
      http.post('*/v1/matches/m-1/results', async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json(decidedActivePersistedMatch)
      }),
    )

    renderBanner({ failGameNumber: 1, activeGameNumber: 2 })

    await user.click(await screen.findByRole('button', { name: 'fail game 1' }))
    await screen.findByRole('button', { name: /Post result/ })
    await user.click(screen.getByRole('button', { name: /Post result/ }))

    await waitFor(() =>
      expect(postedBody).toEqual({
        games: [
          { game_number: 1, side_1_points: 11, side_2_points: 4 },
          { game_number: 2, side_1_points: 11, side_2_points: 5 },
        ],
      }),
    )
  })
})
