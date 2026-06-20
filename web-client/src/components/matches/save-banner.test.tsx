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
import { fireScoreSave } from '@/api/matches'
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

// Render the banner for an active game OTHER than the one that fails, so the
// failure is surfaced (the active game's own failure is suppressed). A sibling
// button re-fires game 3's scratch save imperatively — the same `fireScoreSave`
// the banner's own Retry calls — so a re-failure happens WITHOUT unmounting the
// banner (its dismiss state, the thing under test, must survive).
function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: function Harness() {
      const qc = useQueryClient()
      return (
        <>
          <button
            type="button"
            onClick={() =>
              fireScoreSave(qc, 'm-1', 3, {
                side_1_points: 11,
                side_2_points: 4,
              })
            }
          >
            fail game 3
          </button>
          <SaveBanner matchId="m-1" activeGameNumber={4} />
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

    renderBanner()

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
})
