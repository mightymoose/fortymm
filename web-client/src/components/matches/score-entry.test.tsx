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
  | { kind: 'create'; matchId: string; gameNumber: number }
  | { kind: 'edit'; matchId: string; gameNumber: number }

function renderScoreEntry(spec: RouteSpec, options: { path?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const entryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/entry',
    component: function Entry() {
      return (
        <ScoreEntry
          matchId={spec.matchId}
          gameNumber={spec.gameNumber}
          mode={{ kind: spec.kind }}
        />
      )
    },
  })
  const scoringNew = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: function Stub() {
      const params = scoringNew.useParams()
      return (
        <div>
          scoring-new {params.matchId} {params.gameNumber}
        </div>
      )
    },
  })
  const scoringEdit = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/edit',
    component: function Stub() {
      const params = scoringEdit.useParams()
      return (
        <div>
          scoring-edit {params.matchId} {params.gameNumber}
        </div>
      )
    },
  })
  const matchPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: function Stub() {
      // Hard-code the rendered match id — sibling routes' `$matchId` prefix
      // narrows params to `never`, and the test only needs the literal id.
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
  // Best-of-5, 1-1 on the board, game 3 next up.
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
    ],
    current_game: { game_number: 3 },
    can_score: true,
    can_finalize: false,
    ...overrides,
  })
}

describe('ScoreEntry — create', () => {
  it('POSTs the score (fire-and-forget) and lands on the next un-scored game', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post(
        '*/v1/matches/m-1/games/3/scores/new',
        async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json(
            inProgressMatch({
              sides: participantSides({ meWins: 2, oppWins: 1 }),
              games: [
                { id: 'g-1', game_number: 1, score: score('s-1', 11, 8) },
                { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
                { id: 'g-3', game_number: 3, score: score('s-3', 11, 4) },
              ],
              current_game: { game_number: 4 },
            }),
          )
        },
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(
      screen.getByRole('textbox', { name: 'nguyen.t score' }),
      '4',
    )
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 4')).toBeInTheDocument(),
    )
    expect(captured).toEqual({ side_1_points: 11, side_2_points: 4 })
  })

  it('flips the submit button to "Post result" when this score would decide the match', async () => {
    // Bo5, 2-0 on the board, entering G3. An 11-3 win clinches at 3-0, so
    // the single submit button should POST /results (atomically saving +
    // posting the result for the opponent to confirm) instead of /scores/new.
    const user = userEvent.setup()
    let finalizedBody: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            sides: participantSides({ meWins: 2, oppWins: 0 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
            ],
            current_game: { game_number: 3 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/results', async ({ request }) => {
        finalizedBody = await request.json()
        return HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'completed',
            status_label: 'Final',
            best_of: 5,
            games_to_win: 3,
            sides: participantSides({ meWins: 3, oppWins: 0, meWon: true }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 3) },
            ],
            current_game: null,
            can_score: false,
            can_finalize: false,
          }),
          { status: 201 },
        )
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    // Pre-typing the button is the generic save-and-continue label.
    expect(
      screen.getByRole('button', { name: /save game & next/i }),
    ).toBeInTheDocument()

    await user.type(meInput, '11')
    await user.type(oppInput, '3')

    // The same button morphs into "Post result" because saving this score
    // posts the canonical result of a decided best-of-5; the match flips to
    // "awaiting confirmation" until the opponent confirms.
    const postBtn = screen.getByRole('button', { name: /post result/i })
    expect(postBtn).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /save game & next/i }),
    ).not.toBeInTheDocument()

    await user.click(postBtn)

    await waitFor(() =>
      expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
    )
    expect(finalizedBody).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 4 },
        { game_number: 2, side_1_points: 11, side_2_points: 6 },
        { game_number: 3, side_1_points: 11, side_2_points: 3 },
      ],
    })
  })

  it('blocks an illegal final score client-side without hitting the server', async () => {
    const user = userEvent.setup()
    let posted = 0
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        posted += 1
        return HttpResponse.json(inProgressMatch(), { status: 201 })
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    // 11–10 is illegal (win-by-1). The submit button stays disabled and an
    // inline hint explains why — no request is made.
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
    expect(posted).toBe(0)
  })

  it('redirects to the existing score\'s edit page when landing on /scores/new for an already-scored game', async () => {
    // Browser-Back-after-save flow: the user advanced to game 3, pressed
    // Back to /games/1/scores/new, but game 1 already has a score. Without
    // the redirect we'd render empty inputs over a tally that already counts
    // the win.
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 1 })

    await waitFor(() =>
      expect(screen.getByText('scoring-edit m-1 1')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: /save/i }),
    ).not.toBeInTheDocument()
  })

  it('redirects to the match page when the match is already finalized', async () => {
    // Per-game endpoints 409 on completed matches — the FE bounces the user
    // back to the read-only detail page instead of rendering scoring UI.
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
            can_finalize: false,
          }),
        ),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })

    await waitFor(() =>
      expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: /save/i }),
    ).not.toBeInTheDocument()
  })

  it('surfaces a server 422 inline when finalize fails validation', async () => {
    // Per-game writes are fire-and-forget on errors. Finalize errors *do*
    // surface inline — typically a 422 if local validation drifted out of
    // sync with the server's.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            sides: participantSides({ meWins: 2, oppWins: 0 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
            ],
            current_game: { game_number: 3 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/results', () =>
        HttpResponse.json(
          { detail: 'This payload was rejected by the server.' },
          { status: 422 },
        ),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    await user.type(meInput, '11')
    await user.type(oppInput, '3')
    await user.click(screen.getByRole('button', { name: /post result/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/rejected by the server/i)
    expect(meInput).toHaveAttribute('aria-invalid', 'true')
    expect(oppInput).toHaveAttribute('aria-invalid', 'true')

    // Editing either input clears the error.
    await user.clear(meInput)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('ScoreEntry — edit', () => {
  it('pre-populates inputs from the stored score and PUTs the new value', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.put(
        '*/v1/matches/m-1/games/1/scores',
        async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json(inProgressMatch())
        },
      ),
    )

    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 1 })

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
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    // After editing a past game, navigate to the next un-scored slot — NOT
    // to "the next-numbered game" (which would be game 2).
    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 3')).toBeInTheDocument(),
    )
    expect(captured).toEqual({ side_1_points: 12, side_2_points: 10 })
  })

  it('clears the saved score and lands back on the same game in create mode', async () => {
    const user = userEvent.setup()
    let deleted = false
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.delete('*/v1/matches/m-1/games/1/scores', () => {
        deleted = true
        return HttpResponse.json(inProgressMatch())
      }),
    )

    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 1 })

    await screen.findByRole('textbox', { name: 'rita.kovac score' })
    // Match the standalone "Clear" button — the scoreline cells carry
    // "Clear game N" labels and would otherwise collide with /clear/i.
    await user.click(screen.getByRole('button', { name: /^clear$/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 1')).toBeInTheDocument(),
    )
    expect(deleted).toBe(true)
  })

  it("✕ on another game's cell clears that game in place without leaving the page", async () => {
    // User is entering game 3 in /new mode. Game 1 is already logged. They
    // tap the ✕ on G1's scoreline cell: G1 is cleared via DELETE
    // /v1/matches/m-1/games/1/scores, the page stays put (no redirect), and
    // focus lands on the first empty input on the active game.
    const user = userEvent.setup()
    let deletedGameNumber: number | null = null
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.delete('*/v1/matches/m-1/games/:gameNumber/scores', ({ params }) => {
        deletedGameNumber = Number(params.gameNumber)
        // Test only asserts the path param + that we stay on the page +
        // focus — no response field is read, so any valid MatchDetails will
        // do.
        return HttpResponse.json(inProgressMatch())
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    // Type something in the opp input so we can verify focus lands on the
    // first *empty* input — which should still be the me input.
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.type(oppInput, '7')

    await user.click(screen.getByRole('button', { name: /clear game 1/i }))

    await waitFor(() => expect(deletedGameNumber).toBe(1))
    // No redirect — still on the active game's entry route.
    expect(
      screen.queryByText(/scoring-(new|edit) m-1/),
    ).not.toBeInTheDocument()
    expect(meInput).toHaveFocus()
  })

  it('redirects edit→new when the game has no saved score', async () => {
    // Sometimes the user follows an /edit deeplink for a game whose score
    // was cleared (or never written). The component swaps to /scores/new so
    // the submit button targets the create endpoint.
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 8) },
              { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
            ],
            current_game: { game_number: 3 },
          }),
        ),
      ),
    )

    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 3 })

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 3')).toBeInTheDocument(),
    )
  })
})
