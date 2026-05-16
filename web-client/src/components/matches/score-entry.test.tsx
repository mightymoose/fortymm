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
import { server } from '@/mocks/server'
import { matchDetails } from '@/test/factories'
import { useCreateScore, useUpdateScore } from '@/api/matches'
import { ScoreEntry } from './score-entry'

type RouteSpec =
  | { kind: 'create'; matchId: string; gameId: string }
  | { kind: 'edit'; matchId: string; gameId: string; scoreId: string }

function renderScoreEntry(spec: RouteSpec, options: { path?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const entryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/entry',
    component: function Entry() {
      // Mount the mutation hook inside the route component so it lives in the
      // same QueryClient as the cached match data.
      if (spec.kind === 'create') {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const mutation = useCreateScore(spec.matchId, spec.gameId)
        return (
          <ScoreEntry
            matchId={spec.matchId}
            gameId={spec.gameId}
            mode={{ kind: 'create' }}
            mutation={mutation}
          />
        )
      }
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const mutation = useUpdateScore(spec.matchId, spec.gameId, spec.scoreId)
      return (
        <ScoreEntry
          matchId={spec.matchId}
          gameId={spec.gameId}
          mode={{ kind: 'edit', scoreId: spec.scoreId }}
          mutation={mutation}
        />
      )
    },
  })
  const scoringNew = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/new',
    component: function Stub() {
      const params = scoringNew.useParams()
      return <div>scoring-new {params.matchId} {params.gameId}</div>
    },
  })
  const scoringEdit = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/$scoreId/edit',
    component: function Stub() {
      const params = scoringEdit.useParams()
      return (
        <div>
          scoring-edit {params.matchId} {params.gameId} {params.scoreId}
        </div>
      )
    },
  })
  const matchPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: function Stub() {
      // Hard-code the rendered match id — the route's inferred params type
      // narrows to `never` once sibling routes share the `$matchId` prefix,
      // and the test only needs the literal id to assert on.
      return <div>match-page {spec.matchId}</div>
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      entryRoute,
      scoringNew,
      scoringEdit,
      matchPage,
    ]),
    history: createMemoryHistory({ initialEntries: [options.path ?? '/entry'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function inProgressMatch(overrides: Parameters<typeof matchDetails>[0] = {}) {
  // 3 games: 1-2 scored, 3 current.
  return matchDetails({
    id: 'm-1',
    status: 'in_progress',
    status_label: 'Live',
    best_of: 5,
    games_to_win: 3,
    affects_rating: true,
    my_side: {
      side_number: 1,
      players: [
        { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
      ],
      games_won: 1,
      won: null,
      is_current_user_side: true,
    },
    opponent_side: {
      side_number: 2,
      players: [
        { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
      ],
      games_won: 1,
      won: null,
      is_current_user_side: false,
    },
    games: [
      {
        id: 'g-1',
        game_number: 1,
        score: { id: 's-1', my_points: 11, opponent_points: 8, is_my_win: true },
      },
      {
        id: 'g-2',
        game_number: 2,
        score: { id: 's-2', my_points: 9, opponent_points: 11, is_my_win: false },
      },
      { id: 'g-3', game_number: 3, score: null },
    ],
    current_game: { id: 'g-3', game_number: 3 },
    can_score: true,
    ...overrides,
  })
}

describe('ScoreEntry — create', () => {
  it('POSTs the score and navigates to the new current_game on success', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post(
        '*/v1/matches/m-1/games/g-3/scores',
        async ({ request }) => {
          captured = await request.json()
          // After scoring game 3, an unscored game 4 is reconciled in.
          const next = inProgressMatch({
            my_side: {
              side_number: 1,
              players: [
                {
                  user_id: 'u-me',
                  username: 'rita.kovac',
                  is_current_user: true,
                },
              ],
              games_won: 2,
              won: null,
              is_current_user_side: true,
            },
            games: [
              {
                id: 'g-1',
                game_number: 1,
                score: {
                  id: 's-1',
                  my_points: 11,
                  opponent_points: 8,
                  is_my_win: true,
                },
              },
              {
                id: 'g-2',
                game_number: 2,
                score: {
                  id: 's-2',
                  my_points: 9,
                  opponent_points: 11,
                  is_my_win: false,
                },
              },
              {
                id: 'g-3',
                game_number: 3,
                score: {
                  id: 's-3',
                  my_points: 11,
                  opponent_points: 4,
                  is_my_win: true,
                },
              },
              { id: 'g-4', game_number: 4, score: null },
            ],
            current_game: { id: 'g-4', game_number: 4 },
          })
          return HttpResponse.json(next)
        },
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-3' })

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(screen.getByRole('textbox', { name: 'rita.kovac score' }), '11')
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(
        screen.getByText('scoring-new m-1 g-4'),
      ).toBeInTheDocument(),
    )
    expect(captured).toEqual({ side_1_points: 11, side_2_points: 4 })
  })

  it('navigates to the match page when the deciding game closes out the match', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            my_side: {
              side_number: 1,
              players: [
                {
                  user_id: 'u-me',
                  username: 'rita.kovac',
                  is_current_user: true,
                },
              ],
              // Already 2-1 leading; this game decides it.
              games_won: 2,
              won: null,
              is_current_user_side: true,
            },
            games: [
              {
                id: 'g-1',
                game_number: 1,
                score: { id: 's-1', my_points: 11, opponent_points: 4, is_my_win: true },
              },
              {
                id: 'g-2',
                game_number: 2,
                score: { id: 's-2', my_points: 11, opponent_points: 6, is_my_win: true },
              },
              {
                id: 'g-3',
                game_number: 3,
                score: { id: 's-3', my_points: 5, opponent_points: 11, is_my_win: false },
              },
              { id: 'g-4', game_number: 4, score: null },
            ],
            current_game: { id: 'g-4', game_number: 4 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/games/g-4/scores', () => {
        const done = inProgressMatch({
          status: 'completed',
          status_label: 'Final',
          my_side: {
            side_number: 1,
            players: [
              { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
            ],
            games_won: 3,
            won: true,
            is_current_user_side: true,
          },
          games: [
            {
              id: 'g-4',
              game_number: 4,
              score: { id: 's-4', my_points: 11, opponent_points: 7, is_my_win: true },
            },
          ],
          current_game: null,
          can_score: false,
        })
        return HttpResponse.json(done)
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-4' })

    await screen.findByRole('heading', { name: /enter game 4 score/i })
    await user.type(screen.getByRole('textbox', { name: 'rita.kovac score' }), '11')
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '7')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
    )
  })

  it('renders the 422 detail inline and clears it when the user edits an input', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/g-3/scores', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            {
              detail:
                'At 10–10 the game enters deuce; the winner must lead by 2. 11–10 is not a legal final score.',
            },
            { status: 422 },
          )
        }
        return HttpResponse.json(
          inProgressMatch({
            games: [
              {
                id: 'g-3',
                game_number: 3,
                score: {
                  id: 's-3',
                  my_points: 12,
                  opponent_points: 10,
                  is_my_win: true,
                },
              },
              { id: 'g-4', game_number: 4, score: null },
            ],
            current_game: { id: 'g-4', game_number: 4 },
          }),
        )
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-3' })
    const meInput = await screen.findByRole('textbox', { name: 'rita.kovac score' })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    await user.type(meInput, '11')
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/not a legal final score/i)
    expect(meInput).toHaveAttribute('aria-invalid', 'true')
    expect(oppInput).toHaveAttribute('aria-invalid', 'true')

    // Editing either input clears the error and re-enables the field.
    await user.clear(meInput)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.type(meInput, '12')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 g-4')).toBeInTheDocument(),
    )
  })

  it('surfaces an edit-link affordance when the game is already scored (409)', async () => {
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            games: [
              {
                id: 'g-3',
                game_number: 3,
                score: {
                  id: 's-3-existing',
                  my_points: 11,
                  opponent_points: 6,
                  is_my_win: true,
                },
              },
              { id: 'g-4', game_number: 4, score: null },
            ],
            current_game: { id: 'g-4', game_number: 4 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/games/g-3/scores', () =>
        HttpResponse.json(
          { detail: 'This game has already been scored.' },
          { status: 409 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-3' })

    const meInput = await screen.findByRole('textbox', { name: 'rita.kovac score' })
    await user.type(meInput, '11')
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '6')
    await user.click(screen.getByRole('button', { name: /save/i }))

    const editLink = await screen.findByRole('link', {
      name: /edit existing score/i,
    })
    expect(editLink).toHaveAttribute(
      'href',
      '/matches/m-1/games/g-3/scores/s-3-existing/edit',
    )
  })

  it('disables the form and shows a back link when the match is no longer scorable (409)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/g-3/scores', () =>
        HttpResponse.json(
          { detail: 'This match is no longer scorable.' },
          { status: 409 },
        ),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-3' })
    await user.type(
      await screen.findByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '6')
    await user.click(screen.getByRole('button', { name: /save/i }))

    const alert = await screen.findByText(/no longer scorable/i)
    expect(alert).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'rita.kovac score' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'nguyen.t score' })).toBeDisabled()
    // The primary "Back to match" CTA replaces the save button. The live-bar
    // link is the persistent "← Back to match" at the top — we want the new
    // primary CTA below.
    expect(
      screen.getByRole('link', { name: 'Back to match' }),
    ).toHaveAttribute('href', '/matches/m-1')
  })
})

describe('ScoreEntry — edit', () => {
  it('pre-populates inputs from the stored score and PUTs the new value', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.put(
        '*/v1/matches/m-1/games/g-1/scores/s-1',
        async ({ request }) => {
          captured = await request.json()
          // After editing g-1, the current_game is still g-3 (per invariant).
          return HttpResponse.json(inProgressMatch())
        },
      ),
    )

    renderScoreEntry({
      kind: 'edit',
      matchId: 'm-1',
      gameId: 'g-1',
      scoreId: 's-1',
    })

    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await waitFor(() => expect(meInput).toHaveValue('11'))
    expect(oppInput).toHaveValue('8')

    await user.clear(meInput)
    await user.type(meInput, '12')
    await user.clear(oppInput)
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save/i }))

    // After editing a past game, navigate to the current_game's /new — NOT
    // to "the next-numbered game" (which would be g-2).
    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 g-3')).toBeInTheDocument(),
    )
    expect(captured).toEqual({ side_1_points: 12, side_2_points: 10 })
  })

  it('re-opens a completed match: navigates to the fresh current_game on the response', async () => {
    const user = userEvent.setup()
    // Mount in a "completed" match's edit page; the PUT response reflects the
    // server having reconciled and appended a new trailing game.
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'completed',
            status_label: 'Final',
            best_of: 3,
            games_to_win: 2,
            my_side: {
              side_number: 1,
              players: [
                {
                  user_id: 'u-me',
                  username: 'rita.kovac',
                  is_current_user: true,
                },
              ],
              games_won: 2,
              won: true,
              is_current_user_side: true,
            },
            opponent_side: {
              side_number: 2,
              players: [
                {
                  user_id: 'u-opp',
                  username: 'nguyen.t',
                  is_current_user: false,
                },
              ],
              games_won: 0,
              won: false,
              is_current_user_side: false,
            },
            games: [
              {
                id: 'g-1',
                game_number: 1,
                score: {
                  id: 's-1',
                  my_points: 11,
                  opponent_points: 4,
                  is_my_win: true,
                },
              },
              {
                id: 'g-2',
                game_number: 2,
                score: {
                  id: 's-2',
                  my_points: 11,
                  opponent_points: 6,
                  is_my_win: true,
                },
              },
            ],
            current_game: null,
            can_score: false,
          }),
        ),
      ),
      http.put('*/v1/matches/m-1/games/g-2/scores/s-2', () =>
        HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'in_progress',
            status_label: 'Live',
            best_of: 3,
            games_to_win: 2,
            my_side: {
              side_number: 1,
              players: [
                {
                  user_id: 'u-me',
                  username: 'rita.kovac',
                  is_current_user: true,
                },
              ],
              games_won: 1,
              won: null,
              is_current_user_side: true,
            },
            opponent_side: {
              side_number: 2,
              players: [
                {
                  user_id: 'u-opp',
                  username: 'nguyen.t',
                  is_current_user: false,
                },
              ],
              games_won: 1,
              won: null,
              is_current_user_side: false,
            },
            games: [
              {
                id: 'g-1',
                game_number: 1,
                score: {
                  id: 's-1',
                  my_points: 11,
                  opponent_points: 4,
                  is_my_win: true,
                },
              },
              {
                id: 'g-2',
                game_number: 2,
                score: {
                  id: 's-2',
                  my_points: 9,
                  opponent_points: 11,
                  is_my_win: false,
                },
              },
              { id: 'g-3', game_number: 3, score: null },
            ],
            current_game: { id: 'g-3', game_number: 3 },
            can_score: true,
          }),
        ),
      ),
    )

    renderScoreEntry({
      kind: 'edit',
      matchId: 'm-1',
      gameId: 'g-2',
      scoreId: 's-2',
    })

    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    await waitFor(() => expect(meInput).toHaveValue('11'))
    await user.clear(meInput)
    await user.type(meInput, '9')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 g-3')).toBeInTheDocument(),
    )
  })
})

