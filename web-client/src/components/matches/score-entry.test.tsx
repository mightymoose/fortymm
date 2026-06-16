import { render, screen, waitFor, within } from '@testing-library/react'
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
  onlineManager,
} from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('advances to the next game immediately, without waiting for the save to settle (#567)', async () => {
    // Mobile keyboard regression: navigation must happen synchronously in the
    // Save tap, not from the save's `onSettled`. If it waited for the network
    // round-trip, the soft keyboard would close and the next game's input would
    // lose focus between games. Here the save POST never resolves, yet we must
    // still land on the next un-scored game.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      // Never resolves — stands in for a slow/in-flight save.
      http.post(
        '*/v1/matches/m-1/games/3/scores/new',
        () => new Promise<Response>(() => {}),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    // Already on game 4 even though the game-3 save is still pending.
    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 4')).toBeInTheDocument(),
    )
  })

  it('treats a 409 on the create POST as a successful re-save (#538)', async () => {
    // A double-tapped Save fires the create POST twice; the second hits an
    // already-saved game and 409s. The mutation must fall back to an update
    // (PUT) so the game lands as saved and we advance — rather than the 409
    // surfacing a false "didn't save" cell.
    const user = userEvent.setup()
    let posts = 0
    let putBody: unknown = null
    const advanced = inProgressMatch({
      sides: participantSides({ meWins: 2, oppWins: 1 }),
      games: [
        { id: 'g-1', game_number: 1, score: score('s-1', 11, 8) },
        { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
        { id: 'g-3', game_number: 3, score: score('s-3', 11, 4) },
      ],
      current_game: { game_number: 4 },
    })
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        posts += 1
        return HttpResponse.json(
          { detail: 'Game already has a score.' },
          { status: 409 },
        )
      }),
      http.put('*/v1/matches/m-1/games/3/scores', async ({ request }) => {
        putBody = await request.json()
        return HttpResponse.json(advanced)
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 4')).toBeInTheDocument(),
    )
    expect(posts).toBe(1)
    expect(putBody).toEqual({ side_1_points: 11, side_2_points: 4 })
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

  it('keeps a 3-digit entry intact instead of silently truncating to 2 digits', async () => {
    // Regression for #442: typing "100" used to be cut to "10", then the
    // win-by-2 check fired against a value the user never entered. The input
    // now keeps up to 3 digits, so the score the user sees is the score the
    // validation reasons about.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    await user.type(meInput, '100')
    expect(meInput).toHaveValue('100')

    // The illegal-score hint references the typed value, not a mutated one:
    // 100–97 is a deuce game that doesn't lead by exactly 2.
    await user.type(oppInput, '97')
    expect(oppInput).toHaveValue('97')
    expect(screen.getByRole('alert')).toHaveTextContent(/leads by exactly 2/i)

    // The field still caps at 3 digits so it can't grow unbounded — a 4th
    // digit typed in one pass is dropped rather than accepted.
    await user.clear(meInput)
    await user.type(meInput, '1005')
    expect(meInput).toHaveValue('100')
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

// ---------------------------------------------------------------------------
// Failed saves (#369): forward navigation stays unblocked, but a non-2xx save
// becomes visible (a banner + failed scoreline cell) and recoverable. The
// per-game save state lives in the shared mutation cache, keyed per game — so
// each cell reads its own outcome and a retry re-fires just that game. These
// tests use a harness whose scoring routes render the real ScoreEntry, so the
// post-navigation screen is the actual next-game page rather than a stub.
// ---------------------------------------------------------------------------

function renderScoringApp(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const scoringNew = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: function NewEntry() {
      const params = scoringNew.useParams()
      return (
        <ScoreEntry
          matchId={params.matchId}
          gameNumber={Number(params.gameNumber)}
          mode={{ kind: 'create' }}
        />
      )
    },
  })
  const scoringEdit = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/edit',
    component: function EditEntry() {
      const params = scoringEdit.useParams()
      return (
        <ScoreEntry
          matchId={params.matchId}
          gameNumber={Number(params.gameNumber)}
          mode={{ kind: 'edit' }}
        />
      )
    },
  })
  const matchPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: function Stub() {
      return <div>match-page</div>
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([scoringNew, scoringEdit, matchPage]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('ScoreEntry — failed saves', () => {
  it('still navigates forward on a 500, but shows the banner and flags the cell with the entered points', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    // Forward navigation is not blocked — we land on game 4 regardless.
    await screen.findByRole('heading', { name: /enter game 4 score/i })

    // The banner names the single failed game and offers a retry.
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent("Game 3 didn't save.")
    expect(banner).toHaveTextContent('tap it in the scoreline to fix the score')
    expect(
      screen.getByRole('button', { name: /^retry$/i }),
    ).toBeInTheDocument()

    // The cell keeps the entered numbers, reads as failed, and is tappable.
    const cell = screen.getByRole('link', {
      name: "Game 3 didn't save, 11 to 4. Tap to fix.",
    })
    expect(cell).toHaveClass('failed')
    expect(cell).toHaveTextContent('11')
    expect(cell).toHaveTextContent('4')
    // The non-color cue: the "Not saved" micro-label is visible in the cell.
    expect(cell).toHaveTextContent('Not saved')
    expect(cell).toHaveAttribute('href', '/matches/m-1/games/3/scores/new')
  })

  it('dismissing the banner keeps the failed cell as the persistent recovery affordance', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 4 score/i })

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: "Game 3 didn't save, 11 to 4. Tap to fix.",
      }),
    ).toBeInTheDocument()
  })

  it('the banner Retry re-fires just that game; a successful retry clears the failure', async () => {
    const user = userEvent.setup()
    let attempts = 0
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        attempts += 1
        if (attempts === 1) {
          return HttpResponse.json({ detail: 'boom' }, { status: 500 })
        }
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
      }),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 4 score/i })

    // Retry in place from the banner — no navigation. The single failed game
    // is re-sent and resolves; the failure state clears everywhere.
    await user.click(screen.getByRole('button', { name: /^retry$/i }))

    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    )
    expect(attempts).toBe(2)
    expect(
      screen.queryByRole('link', { name: /didn't save/i }),
    ).not.toBeInTheDocument()
    // Still on game 4 — retry doesn't navigate.
    expect(
      screen.getByRole('heading', { name: /enter game 4 score/i }),
    ).toBeInTheDocument()
  })

  it("two failed saves read '2 games didn't save' and Retry all fires one request per game", async () => {
    // Two independent failures land in the strip at once via failed *edits*:
    // edits keep the persisted score, so navigation proceeds forward (rather
    // than looping back to the lowest un-scored game the way a failed create
    // would). Games 1 and 2 are already scored; we fail an edit of each, then
    // land on game 3 with both 1 and 2 flagged failed.
    const user = userEvent.setup()
    const attempts: Record<number, number> = { 1: 0, 2: 0 }
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.put('*/v1/matches/m-1/games/:gameNumber/scores', ({ params }) => {
        const gameNumber = Number(params.gameNumber)
        attempts[gameNumber] += 1
        if (attempts[gameNumber] === 1) {
          return HttpResponse.json({ detail: 'boom' }, { status: 500 })
        }
        return HttpResponse.json(inProgressMatch())
      }),
    )

    renderScoringApp('/matches/m-1/games/1/scores/edit')

    // Fail an edit of game 1 → forward to the next un-scored game (3).
    await screen.findByRole('heading', { name: /edit game 1 score/i })
    let meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    await user.clear(meInput)
    await user.type(meInput, '12')
    let oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.clear(oppInput)
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // From game 3, open game 2 (still a plainly-saved cell) and fail its edit.
    await user.click(
      screen.getByRole('link', { name: /game 2, saved/i }),
    )
    await screen.findByRole('heading', { name: /edit game 2 score/i })
    meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    await user.clear(meInput)
    await user.type(meInput, '7')
    oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.clear(oppInput)
    await user.type(oppInput, '11')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // Both failures are independent cells, and the banner counts them.
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent("2 games didn't save.")
    expect(
      screen.getByRole('button', { name: /retry all/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: "Game 1 didn't save, 12 to 10. Tap to fix.",
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: "Game 2 didn't save, 7 to 11. Tap to fix.",
      }),
    ).toBeInTheDocument()

    // Retry all → exactly one fresh request per failed game.
    await user.click(screen.getByRole('button', { name: /retry all/i }))
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    )
    expect(attempts).toEqual({ 1: 2, 2: 2 })
    expect(
      screen.queryByRole('link', { name: /didn't save/i }),
    ).not.toBeInTheDocument()
  })

  it('a failed edit keeps the newly entered points in the failed cell, over the persisted score', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.put('*/v1/matches/m-1/games/1/scores', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderScoringApp('/matches/m-1/games/1/scores/edit')
    await screen.findByRole('heading', { name: /edit game 1 score/i })
    const meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    await user.clear(meInput)
    await user.type(meInput, '12')
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.clear(oppInput)
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    // Navigates on to the next un-scored game (3) as before…
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    // …and G1 shows the *entered* 12–10 (not the persisted 11–8), failed,
    // linking back to the edit screen since a saved score still exists.
    const cell = screen.getByRole('link', {
      name: "Game 1 didn't save, 12 to 10. Tap to fix.",
    })
    expect(cell).toHaveTextContent('12')
    expect(cell).toHaveTextContent('10')
    expect(cell).toHaveAttribute('href', '/matches/m-1/games/1/scores/edit')
  })

  it("the banner is suppressed on the failed game's own entry page", async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    // On game 4 the banner is present (different game).
    await screen.findByRole('heading', { name: /enter game 4 score/i })
    expect(screen.getByRole('alert')).toHaveTextContent("Game 3 didn't save.")

    // Tap the failed cell → back on game 3, pre-filled: banner must be absent.
    await user.click(
      screen.getByRole('link', {
        name: "Game 3 didn't save, 11 to 4. Tap to fix.",
      }),
    )
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
    ).toHaveValue('11')
    expect(screen.getByRole('textbox', { name: 'nguyen.t score' })).toHaveValue(
      '4',
    )
  })

  // Regression: React Query's default `networkMode: 'online'` *pauses*
  // mutations while offline, so the offline Save tap used to do nothing —
  // no navigation, no failed cell. The score-save mutation forces
  // `networkMode: 'always'` so an offline tap fires, fails on the network
  // error, and lands in the same failed-save state as a 500.
  it('offline: Save still fires, navigates forward, and flags the cell as failed', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      // Offline → the request rejects with a network error.
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.error(),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')

    // Load the page online (the match details land in cache), then drop the
    // connection — mirroring a user who opened the match then lost signal.
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    onlineManager.setOnline(false)
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    // Forward navigation still happens — the offline save isn't stuck paused.
    await screen.findByRole('heading', { name: /enter game 4 score/i })

    // It lands in the failed-save state: banner names the game, cell flips to
    // "Not saved" keeping the entered points for a retry.
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent("Game 3 didn't save.")
    const cell = screen.getByRole('link', {
      name: "Game 3 didn't save, 11 to 4. Tap to fix.",
    })
    expect(cell).toHaveClass('failed')
    expect(cell).toHaveTextContent('Not saved')
  })

  // Goal: scores must be enterable offline. The deciding game normally posts
  // the canonical result (/results), the one write we can't fake offline.
  // Offline we instead store it as a scratchpad save so the score survives —
  // we must NOT attempt /results, and the game must land in the failed-save
  // state with its points retained for a later online post.
  it('offline: the deciding game stores as a scratchpad save instead of posting the result', async () => {
    const user = userEvent.setup()
    let resultsCalls = 0
    let scoreCalls = 0
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            // Bo5, 2-0 on the board — an 11-3 win in game 3 clinches at 3-0.
            sides: participantSides({ meWins: 2, oppWins: 0 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
            ],
            current_game: { game_number: 3 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/results', () => {
        resultsCalls += 1
        return HttpResponse.json({ detail: 'should not be called' }, { status: 500 })
      }),
      // Offline → the scratchpad save rejects with a network error.
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        scoreCalls += 1
        return HttpResponse.error()
      }),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')

    // Load online, then go offline — the deciding-game submit follows.
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    onlineManager.setOnline(false)
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '3')

    // The button reads "Post result" (it would decide the match), but offline it
    // stores the score rather than posting.
    await user.click(screen.getByRole('button', { name: /post result/i }))

    // The match is decided, so we DON'T advance to a next game — there's nothing
    // left to play. We stay on the deciding game's screen.
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    expect(
      screen.queryByRole('heading', { name: /enter game 4 score/i }),
    ).not.toBeInTheDocument()
    expect(resultsCalls).toBe(0)
    await waitFor(() => expect(scoreCalls).toBe(1))

    // The recorded games now decide the match (3-0), so the banner surfaces here
    // — informational only. The main "Post result" button (live inputs) owns
    // finalizing, so the banner carries no duplicate post button of its own.
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('These scores finish the match.')
    expect(
      within(banner).queryByRole('button', { name: /post result/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /post result/i }),
    ).toBeInTheDocument()
  })

  // Goal: once enough recorded scores decide the match, the banner's retry
  // posts the canonical result instead of re-saving each game. Continues the
  // offline scenario above — the deciding game is sitting in the strip as a
  // failed scratch save — then comes back online and posts the result from the
  // banner in one shot, with all three games' points (never re-firing the
  // scratch save).
  it('banner retry finalizes (posts the result) once back online', async () => {
    const user = userEvent.setup()
    let resultsBody: unknown = null
    let scoreSaveCalls = 0
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
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        scoreSaveCalls += 1
        return HttpResponse.error()
      }),
      http.post('*/v1/matches/m-1/results', async ({ request }) => {
        resultsBody = await request.json()
        return HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'completed',
            status_label: 'Final',
            best_of: 5,
            games_to_win: 3,
            sides: participantSides({ meWins: 3, oppWins: 0, meWon: true }),
            current_game: null,
            can_score: false,
            can_finalize: false,
          }),
          { status: 201 },
        )
      }),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')

    // Offline: the deciding game stores as a failed scratch save. The match is
    // over, so we stay on the deciding game's screen with the finalize banner.
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    onlineManager.setOnline(false)
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '3')
    await user.click(screen.getByRole('button', { name: /post result/i }))
    await waitFor(() => expect(scoreSaveCalls).toBe(1))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('These scores finish the match.')

    // Back online — the main "Post result" button finalizes in one shot.
    onlineManager.setOnline(true)
    await user.click(screen.getByRole('button', { name: /post result/i }))

    await waitFor(() =>
      expect(screen.getByText('match-page')).toBeInTheDocument(),
    )
    // Canonical result carries every recorded game — and finalizing did NOT
    // re-fire the per-game scratch save.
    expect(scoreSaveCalls).toBe(1)
    expect(resultsBody).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 4 },
        { game_number: 2, side_1_points: 11, side_2_points: 6 },
        { game_number: 3, side_1_points: 11, side_2_points: 3 },
      ],
    })
  })

  // The banner's finalize is guarded on connectivity like the entry screen:
  // offline it must NOT fire /results (which can only fail unseen) — it falls
  // back to re-firing the per-game scratch saves so the scores stay in the strip.
  it('offline: banner retry re-fires the per-game saves instead of posting the result', async () => {
    const user = userEvent.setup()
    let resultsCalls = 0
    let scoreSaveCalls = 0
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
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        scoreSaveCalls += 1
        return HttpResponse.error()
      }),
      http.post('*/v1/matches/m-1/results', () => {
        resultsCalls += 1
        return HttpResponse.json({ detail: 'should not be called' }, { status: 500 })
      }),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    onlineManager.setOnline(false)
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '3')
    await user.click(screen.getByRole('button', { name: /post result/i }))
    await waitFor(() => expect(scoreSaveCalls).toBe(1))

    // Still offline — we stayed on the deciding game. The banner is informational
    // (no button of its own); tapping the main "Post result" re-fires the scratch
    // save (which fails again), and never touches /results.
    const banner = await screen.findByRole('alert')
    expect(
      within(banner).queryByRole('button', { name: /post result/i }),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /post result/i }))
    await waitFor(() => expect(scoreSaveCalls).toBe(2))
    expect(resultsCalls).toBe(0)
  })

  // The finalize hook's contract is that its errors matter (unlike the swallowed
  // per-game saves). When the banner's online finalize fails, it surfaces the
  // server's reason instead of silently reverting.
  it('banner surfaces a finalize error (e.g. result already posted) instead of failing silently', async () => {
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
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.error(),
      ),
      http.post('*/v1/matches/m-1/results', () =>
        HttpResponse.json(
          { detail: 'A result has already been posted.' },
          { status: 409 },
        ),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')

    // Store the deciding game offline so the finalize banner appears.
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    onlineManager.setOnline(false)
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '3')
    await user.click(screen.getByRole('button', { name: /post result/i }))
    // The match is decided — we stay on the deciding game; the banner is
    // informational and the main "Post result" button finalizes.
    await screen.findByRole('alert')

    // Back online, post the result via the main button — the server rejects 409.
    onlineManager.setOnline(true)
    await user.click(screen.getByRole('button', { name: /post result/i }))

    // The reason surfaces inline rather than reverting silently, and the button
    // stays usable for another attempt.
    await screen.findByText('A result has already been posted.')
    expect(
      screen.getByRole('button', { name: /post result/i }),
    ).toBeEnabled()
  })

  // Regression for the fully-offline path (QA BUG 1): with NO games persisted
  // server-side, entering game after game offline must keep advancing — the
  // next-game prediction has to count the failed scratch saves, not just
  // `data.games`, or it bounces back to game 1 and the decided-match banner
  // never appears. Bo3: two offline wins decide the match; we must land on
  // game 3 with the finalize banner, then post the result online.
  it('offline end-to-end: enter every game offline, advance correctly, then post the decided result', async () => {
    const user = userEvent.setup()
    let resultsBody: unknown = null
    server.use(
      // Nothing persisted — every score lands only as a failed scratch save.
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            best_of: 3,
            games_to_win: 2,
            sides: participantSides({ meWins: 0, oppWins: 0 }),
            games: [],
            current_game: { game_number: 1 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/games/:n/scores/new', () =>
        HttpResponse.error(),
      ),
      http.post('*/v1/matches/m-1/results', async ({ request }) => {
        resultsBody = await request.json()
        return HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'completed',
            status_label: 'Final',
            best_of: 3,
            games_to_win: 2,
            sides: participantSides({ meWins: 2, oppWins: 0, meWon: true }),
            current_game: null,
            can_score: false,
            can_finalize: false,
          }),
          { status: 201 },
        )
      }),
    )

    renderScoringApp('/matches/m-1/games/1/scores/new')
    await screen.findByRole('heading', { name: /enter game 1 score/i })
    onlineManager.setOnline(false)

    // Game 1 offline → fails, advances to game 2.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '9')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 2 score/i })

    // Game 2 offline → fails, and must advance to game 3 (NOT bounce back to
    // game 1, which is the bug this guards).
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '7')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // Both offline games sit in the strip, and since they decide the Bo3 the
    // banner offers to post the result.
    expect(
      screen.getByRole('link', { name: /game 1 didn't save, 11 to 9/i }),
    ).toBeInTheDocument()
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('These scores finish the match.')

    // Back online, post the result — both games are carried.
    onlineManager.setOnline(true)
    await user.click(
      within(banner).getByRole('button', { name: /post result/i }),
    )
    await waitFor(() =>
      expect(screen.getByText('match-page')).toBeInTheDocument(),
    )
    expect(resultsBody).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 9 },
        { game_number: 2, side_1_points: 11, side_2_points: 7 },
      ],
    })
  })
})

// ---------------------------------------------------------------------------
// Unsaved-input guard (#441): typing a score and then leaving — via an in-app
// route change — without pressing Save must prompt before discarding it. A
// clean page (or input that matches the saved score) must not nag, and the
// sanctioned Save/Clear paths must navigate without tripping the guard.
// ---------------------------------------------------------------------------

describe('ScoreEntry — unsaved-input guard', () => {
  it('prompts before an in-app navigation away from unsaved typing, and "Keep editing" stays put', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // Type a score but DON'T save it.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )

    // Try to leave by tapping an already-scored game's scoreline cell.
    await user.click(screen.getByRole('link', { name: /game 1, saved/i }))

    // The leave prompt appears instead of navigating. (The modal dialog
    // aria-hides the page behind it, so the heading isn't queryable here —
    // we confirm we never left after dismissing the prompt below.)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/leave without saving/i)

    // "Keep editing" cancels the navigation — still on game 3 with the input.
    await user.click(screen.getByRole('button', { name: /keep editing/i }))
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('heading', { name: /enter game 3 score/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
    ).toHaveValue('11')
  })

  it('"Discard & leave" proceeds with the blocked navigation', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )

    await user.click(screen.getByRole('link', { name: /game 1, saved/i }))
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: /discard & leave/i }))

    // Navigation goes through — game 1 opens in edit mode.
    await screen.findByRole('heading', { name: /edit game 1 score/i })
  })

  it('does not prompt when leaving a clean page (nothing typed)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // No typing — leaving must be friction-free.
    await user.click(screen.getByRole('link', { name: /game 1, saved/i }))
    await screen.findByRole('heading', { name: /edit game 1 score/i })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not prompt after the fire-and-forget Save navigates to the next game', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post(
        '*/v1/matches/m-1/games/3/scores/new',
        () => new Promise<Response>(() => {}),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')

    // Saving advances to game 4 with no leave prompt — the Save hop is
    // sanctioned, not blocked.
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 4 score/i })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

afterEach(() => {
  // Restore connectivity so the offline test doesn't leak into others.
  onlineManager.setOnline(true)
})
