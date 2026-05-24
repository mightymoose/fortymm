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
import type { components } from '@/api/schema'
import { ScoreEntry } from './score-entry'

type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchDetailsScore = components['schemas']['MatchDetailsScore']

// rita.kovac (current user) is always side 1, nguyen.t (opponent) is side 2.
function participantSides({
  meWins,
  oppWins,
  meWon = null,
}: {
  meWins: number
  oppWins: number
  meWon?: boolean | null
}): [MatchDetailsSide, MatchDetailsSide] {
  return [
    {
      side_number: 1,
      players: [
        { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
      ],
      games_won: meWins,
      won: meWon,
      is_current_user_side: true,
    },
    {
      side_number: 2,
      players: [
        { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
      ],
      games_won: oppWins,
      won: meWon === null ? null : !meWon,
      is_current_user_side: false,
    },
  ]
}

// `myPoints` / `oppPoints` are written from the current-user side-1
// perspective; the helper picks the winning side number.
function score(
  id: string,
  myPoints: number,
  oppPoints: number,
): MatchDetailsScore {
  return {
    id,
    side_1_points: myPoints,
    side_2_points: oppPoints,
    winner_side_number: myPoints > oppPoints ? 1 : 2,
  }
}

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
    sides: participantSides({ meWins: 1, oppWins: 1 }),
    games: [
      { id: 'g-1', game_number: 1, score: score('s-1', 11, 8) },
      { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
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
            sides: participantSides({ meWins: 2, oppWins: 1 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 8) },
              { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 4) },
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
            // Already 2-1 leading; this game decides it.
            sides: participantSides({ meWins: 2, oppWins: 1 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
              { id: 'g-3', game_number: 3, score: score('s-3', 5, 11) },
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
          sides: participantSides({ meWins: 3, oppWins: 1, meWon: true }),
          games: [
            { id: 'g-4', game_number: 4, score: score('s-4', 11, 7) },
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

  it('flips Save copy to "finish the match" when the typed score would clinch early', async () => {
    // Bo5, 2-0 on the board, entering G3. A 11-3 win here clinches at 3-0,
    // so the messaging must not promise a non-existent G4. (Bug #12.)
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            sides: participantSides({ meWins: 2, oppWins: 0 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
              { id: 'g-3', game_number: 3, score: null },
            ],
            current_game: { id: 'g-3', game_number: 3 },
          }),
        ),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-3' })
    const meInput = await screen.findByRole('textbox', { name: 'rita.kovac score' })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    // Pre-typing the message is still the generic "continue to game 4" hint.
    expect(
      screen.getByText(/save this game to continue to game 4/i),
    ).toBeInTheDocument()

    await user.type(meInput, '11')
    await user.type(oppInput, '3')

    expect(
      screen.getByText(/save to finish the match/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/continue to game 4/i),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /save & finish match/i }),
    ).toBeInTheDocument()

    // A non-clinching score (opponent wins G3, taking the match to 2-1)
    // restores the "continue to game 4" hint.
    await user.clear(meInput)
    await user.type(meInput, '5')
    await user.clear(oppInput)
    await user.type(oppInput, '11')
    expect(
      screen.getByText(/save this game to continue to game 4/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /save game & next/i }),
    ).toBeInTheDocument()
  })

  it('blocks an illegal final score client-side without hitting the server', async () => {
    const user = userEvent.setup()
    let posted = 0
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/g-3/scores', () => {
        posted += 1
        return HttpResponse.json(
          inProgressMatch({
            games: [
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 9) },
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

    // 11–10 is illegal (win-by-1). The button stays disabled and an inline
    // hint explains why — no request is made.
    await user.type(meInput, '11')
    await user.type(oppInput, '10')
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/deuce/i)
    expect(meInput).toHaveAttribute('aria-invalid', 'true')
    expect(oppInput).toHaveAttribute('aria-invalid', 'true')

    // Correcting to a legal score clears the hint and re-enables Save.
    await user.clear(oppInput)
    await user.type(oppInput, '9')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(save).toBeEnabled()

    await user.click(save)
    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 g-4')).toBeInTheDocument(),
    )
    expect(posted).toBe(1)
  })

  it('renders a server 422 detail inline and clears it when the user edits an input', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/g-3/scores', () => {
        calls += 1
        if (calls === 1) {
          // A client-legal score the server still rejects (e.g. for match
          // state the client doesn't model) — exercises the 422 render path.
          return HttpResponse.json(
            { detail: 'This score was rejected by the server.' },
            { status: 422 },
          )
        }
        return HttpResponse.json(
          inProgressMatch({
            games: [
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 4) },
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
    await user.type(oppInput, '4')
    await user.click(screen.getByRole('button', { name: /save/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/rejected by the server/i)
    expect(meInput).toHaveAttribute('aria-invalid', 'true')
    expect(oppInput).toHaveAttribute('aria-invalid', 'true')

    // Editing either input clears the error and re-enables the field.
    await user.clear(meInput)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.type(meInput, '11')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 g-4')).toBeInTheDocument(),
    )
  })

  it('locks the page when a concurrent scorer beat us to it and the server 409s (race)', async () => {
    // The cache says the game is un-scored, but between our GET and POST
    // another participant scored it. The cache-first "already scored" case
    // is caught proactively by the redirect (see the next test); this test
    // covers the post-submit race where game.score is null in the cache.
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
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

    expect(
      await screen.findByText(/already been scored/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Back to match' }),
    ).toHaveAttribute('href', '/matches/m-1')
  })

  it('redirects to the existing score\'s edit page when landing on /scores/new for an already-scored game', async () => {
    // Simulates the browser-Back-after-save flow: the user advanced to game 3
    // (scoring g-3), pressed Back to /games/g-1/scores/new, but g-1 already
    // has a score on the server. Without the redirect the page would render
    // empty inputs over a tally that already counts the win, and an enabled
    // Save would either 409 or duplicate.
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameId: 'g-1' })

    await waitFor(() =>
      expect(screen.getByText('scoring-edit m-1 g-1 s-1')).toBeInTheDocument(),
    )
    // The /scores/new page must not have rendered its Save button.
    expect(
      screen.queryByRole('button', { name: /save/i }),
    ).not.toBeInTheDocument()
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
    // The primary "Back to match" CTA replaces the save button.
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
            sides: participantSides({ meWins: 2, oppWins: 0, meWon: true }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
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
            sides: participantSides({ meWins: 1, oppWins: 1 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
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
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await waitFor(() => expect(meInput).toHaveValue('11'))
    // Flip game 2 to a legal opponent win (9–11) so the edit re-opens the match.
    await user.clear(meInput)
    await user.type(meInput, '9')
    await user.clear(oppInput)
    await user.type(oppInput, '11')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 g-3')).toBeInTheDocument(),
    )
  })
})

