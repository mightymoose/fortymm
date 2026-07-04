import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
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
    version: 1,
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
      const params = useParams({ strict: false })
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
      const params = useParams({ strict: false })
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

// Mirror of `participantSides` with the current user on side 2 — the opponent
// holds side 1. Exercises the `mySideNumber === 1 ? … : …` flip for its side-2
// branch, which every other fixture leaves untested (#210).
function participantSidesMeSide2({
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
        { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
      ],
      games_won: oppWins,
      won: meWon === null ? null : !meWon,
      is_current_user_side: false,
    },
    {
      side_number: 2,
      players: [
        { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
      ],
      games_won: meWins,
      won: meWon,
      is_current_user_side: true,
    },
  ]
}

// Raw game score from the side-2 perspective: `side_1_points` holds the
// opponent's points and `side_2_points` holds mine (the inverse of `score`).
function scoreSide2(
  id: string,
  myPoints: number,
  oppPoints: number,
): MatchDetailsScore {
  return {
    id,
    side_1_points: oppPoints,
    side_2_points: myPoints,
    winner_side_number: myPoints > oppPoints ? 2 : 1,
    version: 1,
  }
}

function inProgressMatchMeSide2(
  overrides: Parameters<typeof matchDetails>[0] = {},
) {
  return matchDetails({
    id: 'm-1',
    status: 'in_progress',
    status_label: 'Live',
    best_of: 5,
    games_to_win: 3,
    affects_rating: true,
    sides: participantSidesMeSide2({ meWins: 1, oppWins: 1 }),
    games: [
      { id: 'g-1', game_number: 1, score: scoreSide2('s-1', 11, 8) },
      { id: 'g-2', game_number: 2, score: scoreSide2('s-2', 9, 11) },
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

  it('surfaces a conflict — and fires NO blind PUT — when the create POST 409s (#538 data-loss fix)', async () => {
    // Was #538: a 409 on the create POST used to be swallowed and re-issued as
    // a PUT, which silently overwrote the score a concurrent participant had
    // already saved (last-write-wins data loss). Now the single conditional
    // write never auto-promotes: the 409 surfaces as a conflict to review, and
    // crucially no PUT fires behind the user's back.
    const user = userEvent.setup()
    let posts = 0
    let puts = 0
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        posts += 1
        return HttpResponse.json(
          {
            detail: {
              message:
                'This game was saved by someone else while you were editing.',
              committed_score: null,
            },
          },
          { status: 409 },
        )
      }),
      http.put('*/v1/matches/m-1/games/3/scores', () => {
        puts += 1
        return HttpResponse.json(inProgressMatch())
      }),
    )

    // Real next-game screen (not a stub) so the conflict banner is observable.
    renderScoringApp('/matches/m-1/games/3/scores/new')

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    // Fire-and-forget still advances us to game 4.
    await screen.findByRole('heading', { name: /enter game 4 score/i })

    // The rejected save shows as a conflict to review — never a blind retry.
    await screen.findByText(/game 3 was saved by someone else/i)
    expect(
      screen.getByRole('button', { name: /review game 3/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^retry$/i }),
    ).not.toBeInTheDocument()

    // Exactly one write attempt: the create. No PUT walked around the 409.
    expect(posts).toBe(1)
    expect(puts).toBe(0)
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

  it('blocks with a "the score changed" interstitial when the first-post loses to a concurrent scratchpad save (D1)', async () => {
    // The poster is stale: their view is 2-0 with game 3 unplayed, so typing a
    // win reads as a 3-0 sweep. But the opponent has committed game 3 in *their*
    // favor (real board 2-1). Posting the sweep 409s with the committed match;
    // the entry screen must replace the score pad with a blocking notice instead
    // of silently overwriting the opponent's game 3.
    const user = userEvent.setup()
    const committedMatch = matchDetails({
      id: 'm-1',
      status: 'in_progress',
      status_label: 'Live',
      best_of: 5,
      games_to_win: 3,
      affects_rating: true,
      sides: participantSides({ meWins: 2, oppWins: 1 }),
      games: [
        { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
        { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
        // Opponent's committed game 3 — 3-11 in their favor.
        { id: 'g-3', game_number: 3, score: score('s-3', 3, 11) },
      ],
      current_game: { game_number: 4 },
      can_score: true,
      can_finalize: false,
    })
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
          {
            detail: {
              message: 'The score changed while you were entering it.',
              committed_match: committedMatch,
            },
          },
          { status: 409 },
        ),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.type(meInput, '11')
    await user.type(oppInput, '0')
    await user.click(screen.getByRole('button', { name: /post result/i }))

    // The blocking interstitial replaces the score pad, names the game the
    // opponent committed, and shows the true (2-1) board isn't over.
    expect(
      await screen.findByText(/the score changed while you were entering it/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/Game 3:/)).toBeInTheDocument()
    expect(screen.getByText(/2–1 and isn't over/i)).toBeInTheDocument()
    // The editable field is gone — no path to re-overwrite the committed game.
    expect(
      screen.queryByRole('textbox', { name: 'rita.kovac score' }),
    ).not.toBeInTheDocument()

    // "Resume scoring →" takes the poster to the next unplayed game (4).
    await user.click(screen.getByRole('button', { name: /resume scoring/i }))
    expect(await screen.findByText('scoring-new m-1 4')).toBeInTheDocument()
  })

  it('finalizes an out-of-order clinch (game 4 blank) and posts the compacted board (#742)', async () => {
    // The repro: Bo7, games 1-3 to side 1, then the user jumps to game 5 (game 4
    // still blank) and scores the clinching 4th win there. That leaves a gappy
    // decided board [1,2,3,5]. Pre-fix the button stayed "save & next" and the
    // save funnelled into the empty game 4 (dead-end). Now the board compacts to
    // [1,2,3,4]: the button flips to "Post result" and posts the contiguous board.
    const user = userEvent.setup()
    let finalizedBody: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            best_of: 7,
            games_to_win: 4,
            sides: participantSides({ meWins: 3, oppWins: 0 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 5) },
            ],
            current_game: { game_number: 4 },
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
            best_of: 7,
            games_to_win: 4,
            sides: participantSides({ meWins: 4, oppWins: 0, meWon: true }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 5) },
              { id: 'g-4', game_number: 4, score: score('s-4', 11, 3) },
            ],
            current_game: null,
            can_score: false,
            can_finalize: false,
          }),
          { status: 201 },
        )
      }),
    )

    // Land on game 5 — the out-of-order slot the scoreline let the user tap.
    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 5 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    await user.type(meInput, '11')
    await user.type(oppInput, '3')

    // The clinch is recognised through compaction, so the button offers to post
    // the result rather than funnelling into the empty game 4.
    const postBtn = screen.getByRole('button', { name: /post result/i })
    expect(postBtn).toBeInTheDocument()
    await user.click(postBtn)

    await waitFor(() =>
      expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
    )
    // The posted board is contiguous: the stray "game 5" was renumbered to 4.
    expect(finalizedBody).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 4 },
        { game_number: 2, side_1_points: 11, side_2_points: 6 },
        { game_number: 3, side_1_points: 11, side_2_points: 5 },
        { game_number: 4, side_1_points: 11, side_2_points: 3 },
      ],
    })
  })

  it('fires a single POST /results when "Post result" is double-clicked in one frame (#641)', async () => {
    // A fast double-tap lands a second click before React commits the button's
    // `disabled` re-render. That fired two concurrent POST /results that piled
    // up and wedged the backend; the synchronous in-flight ref must swallow the
    // second tap. Two *synchronous* fireEvent clicks reproduce the same-frame
    // race (awaited user-event clicks would let the `disabled` attr alone block
    // the second, hiding the regression).
    const user = userEvent.setup()
    let requests = 0
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
      // Never resolves — keeps the finalize in flight so the test can count the
      // POSTs the double-click produced.
      http.post('*/v1/matches/m-1/results', () => {
        requests += 1
        return new Promise<never>(() => {})
      }),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.type(meInput, '11')
    await user.type(oppInput, '3')

    const postBtn = screen.getByRole('button', { name: /post result/i })
    fireEvent.click(postBtn)
    fireEvent.click(postBtn)

    await waitFor(() => expect(postBtn).toBeDisabled())
    expect(requests).toBe(1)
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

  it('explains that both scores are required when only one field is filled (#387)', async () => {
    // With exactly one score entered, Save is disabled with no reason given.
    // Surface an inline hint and flag the still-empty field so the disabled
    // button isn't a silent dead end.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    // Untouched: no hint, no red.
    expect(screen.queryByText(/enter both scores/i)).not.toBeInTheDocument()

    await user.type(meInput, '11')
    // One side filled → hint appears, Save disabled, the empty field flagged.
    expect(screen.getByText(/enter both scores to save this game/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    expect(oppInput).toHaveAttribute('aria-invalid', 'true')
    expect(meInput).not.toHaveAttribute('aria-invalid', 'true')

    // Filling the second score clears the hint and enables Save.
    await user.type(oppInput, '9')
    expect(screen.queryByText(/enter both scores/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
    expect(oppInput).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps a 2-digit entry intact instead of silently truncating to 1 digit', async () => {
    // Regression for #442: typing a two-digit score used to be cut short,
    // then the win-by-2 check fired against a value the user never entered.
    // The input keeps the digits the user typed, so the score the user sees
    // is the score the validation reasons about.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })

    await user.type(meInput, '15')
    expect(meInput).toHaveValue('15')

    // The illegal-score hint references the typed value, not a mutated one:
    // 15–12 is a deuce game that doesn't lead by exactly 2.
    await user.type(oppInput, '12')
    expect(oppInput).toHaveValue('12')
    expect(screen.getByRole('alert')).toHaveTextContent(/leads by exactly 2/i)

    // A 3rd digit is no longer truncated to a plausible 2-digit score (#624,
    // #771 — the FE input caps at 99, matching the server's per-side cap):
    // the over-long value is kept verbatim and flagged as malformed instead.
    await user.clear(meInput)
    await user.type(meInput, '100')
    expect(meInput).toHaveValue('100')
    expect(meInput).toHaveAttribute('aria-invalid', 'true')
  })

  it('flags malformed input instead of coercing it to a different number', async () => {
    // Regression for #624: the field used to strip/truncate, so "11.5" became
    // "115" and "999999" became "999" — values the user never typed that pass
    // as real scores. The raw text is now kept and a malformed entry is flagged
    // inline (with Save blocked) rather than silently transformed.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })

    // A decimal stays "11.5" — it never becomes "115" — and is flagged.
    await user.type(meInput, '11.5')
    expect(meInput).toHaveValue('11.5')
    expect(meInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/i)

    // Overflowing digits stay "999999" — not capped to a plausible "999".
    await user.clear(meInput)
    await user.type(meInput, '999999')
    expect(meInput).toHaveValue('999999')
    expect(meInput).toHaveAttribute('aria-invalid', 'true')

    // Letters are still rejected at the keystroke, as before.
    await user.clear(meInput)
    await user.type(meInput, '1a2')
    expect(meInput).toHaveValue('12')
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

    // Editing either input clears the server error. (Clearing one field leaves
    // exactly one score filled, so the lower-severity "both scores required"
    // hint takes over — the 422 message itself is gone and the fields are no
    // longer flagged for that error.)
    await user.clear(meInput)
    expect(
      screen.queryByText(/rejected by the server/i),
    ).not.toBeInTheDocument()
  })
})

describe('ScoreEntry — name layout (#566)', () => {
  // A long username used to overflow the score card on desktop: the desktop
  // `.se-head .nm` rule had no clipping, and its flex parents didn't allow the
  // text column to shrink. jsdom can't measure layout, so we assert the
  // structural contract the CSS depends on: each name renders in `.se-head .nm`
  // inside a `.se-head .id` shrink wrapper. Both must exist or the clipping
  // (overflow/ellipsis + min-width:0) the CSS applies has nothing to bite on.
  it('renders each username in a shrinkable .se-head .id > .nm wrapper', async () => {
    const longName = 'this.is.a.really.long.username.that.overflows'
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            sides: [
              {
                side_number: 1,
                players: [
                  { user_id: 'u-me', username: longName, is_current_user: true },
                ],
                games_won: 1,
                won: null,
                is_current_user_side: true,
              },
              {
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
            ],
          }),
        ),
      ),
    )

    const { container } = renderScoreEntry({
      kind: 'create',
      matchId: 'm-1',
      gameNumber: 3,
    })
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    const nameEl = screen.getByText(longName)
    // The name lives in `.se-head .nm` — the element the desktop overflow rule
    // targets — nested in the `.id` shrink wrapper (`min-width: 0`).
    expect(nameEl).toHaveClass('nm')
    const idWrapper = nameEl.parentElement
    expect(idWrapper).toHaveClass('id')
    expect(idWrapper?.closest('.se-head')).not.toBeNull()
    // Both heads carry the shrink wrapper, so neither name can push its column
    // out of the card.
    expect(container.querySelectorAll('.se-head .id')).toHaveLength(2)
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
    // The conditional write echoes the version the page read (the stored
    // score is version 1), so the server can reject a stale overwrite.
    expect(captured).toEqual({
      side_1_points: 12,
      side_2_points: 10,
      expected_version: 1,
    })
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

    // Clearing now asks first (#387) — nothing is deleted until confirmed.
    await screen.findByRole('alertdialog')
    expect(deleted).toBe(false)
    await user.click(screen.getByRole('button', { name: /clear game/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 1')).toBeInTheDocument(),
    )
    expect(deleted).toBe(true)
  })

  it('cancelling the clear confirmation keeps the saved score (#387)', async () => {
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
    await user.click(screen.getByRole('button', { name: /^clear$/i }))

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /keep score/i }))

    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    )
    expect(deleted).toBe(false)
    // Still on the edit screen, score intact — no navigation away.
    expect(screen.queryByText('scoring-new m-1 1')).not.toBeInTheDocument()
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

    // Confirm first (#387): the ✕ opens a dialog scoped to game 1.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading')).toHaveTextContent(
      /clear game 1\?/i,
    )
    expect(deletedGameNumber).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /clear game/i }))

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
      const params = useParams({ strict: false })
      return (
        <ScoreEntry
          matchId={params.matchId!}
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
      const params = useParams({ strict: false })
      return (
        <ScoreEntry
          matchId={params.matchId!}
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

  it('does not prompt for a stray "." typed over an already-saved score', async () => {
    // Regression for #624 + #441: the field keeps malformed text verbatim now,
    // so a trailing "." in "11." must not read as a change from the saved "11"
    // and spuriously trip the unsaved-changes blocker — the dirty check
    // compares digits only.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderScoringApp('/matches/m-1/games/1/scores/edit')
    await screen.findByRole('heading', { name: /edit game 1 score/i })

    const meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    expect(meInput).toHaveValue('11')
    await user.type(meInput, '.')
    expect(meInput).toHaveValue('11.')

    // Leaving for another saved game goes through with no leave prompt.
    await user.click(screen.getByRole('link', { name: /game 2, saved/i }))
    await screen.findByRole('heading', { name: /edit game 2 score/i })
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

describe('ScoreEntry — conflicts', () => {
  it('routes a conflicting edit to review, shows committed-vs-mine, and keeps the saved score', async () => {
    const user = userEvent.setup()
    let puts = 0
    // The server's committed truth for game 1 is the opponent's 11–5 — what a
    // refetch sees. Our edit will lose the version race and 409.
    const committed = () =>
      inProgressMatch({
        games: [
          { id: 'g-1', game_number: 1, score: score('s-1', 11, 5) },
          { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
        ],
      })
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(committed())),
      http.put('*/v1/matches/m-1/games/1/scores', () => {
        puts += 1
        return HttpResponse.json(
          {
            detail: {
              message:
                'This game was saved by someone else while you were editing.',
              committed_score: {
                id: 's-1',
                side_1_points: 11,
                side_2_points: 5,
                winner_side_number: 1,
                version: 3,
              },
            },
          },
          { status: 409 },
        )
      }),
    )

    renderScoringApp('/matches/m-1/games/1/scores/edit')

    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    await waitFor(() => expect(meInput).toHaveValue('11'))
    await user.clear(meInput)
    await user.type(meInput, '12')
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.clear(oppInput)
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    // Fire-and-forget advances us; the rejected save shows in the banner.
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // The game 1 scoreline cell must show the COMMITTED score (11–5), not our
    // rejected 12–10 entry — presenting the losing scratch there would imply
    // our value won, the exact confusion the conflict flow prevents.
    expect(
      await screen.findByRole('link', {
        name: /game 1 was saved by someone else as 11 to 5\. tap to review/i,
      }),
    ).toBeInTheDocument()

    await user.click(
      await screen.findByRole('button', { name: /review game 1/i }),
    )

    // Back on game 1's edit screen, the in-page conflict notice shows the
    // committed score and our rejected entry, and makes us choose.
    await screen.findByRole('heading', { name: /edit game 1 score/i })
    const notice = (
      await screen.findByText(/this game was saved by someone else/i)
    ).closest('[role="alert"]') as HTMLElement
    expect(notice).toHaveTextContent(/rita\.kovac 11.5 nguyen\.t/)
    expect(notice).toHaveTextContent(/your entry was 12.10/i)

    // "Keep saved score" discards our entry; the notice clears and the inputs
    // fall back to the committed score.
    await user.click(
      screen.getByRole('button', { name: /keep saved score/i }),
    )
    await waitFor(() =>
      expect(
        screen.queryByText(/this game was saved by someone else/i),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
    ).toHaveValue('11')
    expect(
      screen.getByRole('textbox', { name: 'nguyen.t score' }),
    ).toHaveValue('5')

    // Keeping never writes — only the one rejected PUT ever fired.
    expect(puts).toBe(1)
  })

  it('overwrites with my score when I choose to replace, using the version from the conflict body', async () => {
    const user = userEvent.setup()
    const putBodies: Array<Record<string, number>> = []
    // The committed row sits at version 1 until our stale write loses the race;
    // the opponent's winning write has bumped it to 2. A refetch reflects that.
    let committedVersion = 1
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            games: [
              {
                id: 'g-1',
                game_number: 1,
                score: {
                  id: 's-1',
                  side_1_points: 11,
                  side_2_points: 5,
                  winner_side_number: 1,
                  version: committedVersion,
                },
              },
              { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
            ],
          }),
        ),
      ),
      http.put('*/v1/matches/m-1/games/1/scores', async ({ request }) => {
        const body = (await request.json()) as Record<string, number>
        putBodies.push(body)
        // First write claims version 1 and loses; the committed row is now at
        // version 2. The 409 carries that committed score so the client can
        // re-decide and re-fire with the fresh version.
        if (putBodies.length === 1) {
          committedVersion = 2
          return HttpResponse.json(
            {
              detail: {
                message: 'This game was saved by someone else.',
                committed_score: {
                  id: 's-1',
                  side_1_points: 11,
                  side_2_points: 5,
                  winner_side_number: 1,
                  version: 2,
                },
              },
            },
            { status: 409 },
          )
        }
        return HttpResponse.json(inProgressMatch())
      }),
    )

    renderScoringApp('/matches/m-1/games/1/scores/edit')

    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    await waitFor(() => expect(meInput).toHaveValue('11'))
    await user.clear(meInput)
    await user.type(meInput, '12')
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.clear(oppInput)
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.click(
      await screen.findByRole('button', { name: /review game 1/i }),
    )
    await screen.findByRole('heading', { name: /edit game 1 score/i })
    await user.click(
      screen.getByRole('button', { name: /replace with my score/i }),
    )

    // The replace re-fires the write — a deliberate overwrite against the
    // version we just showed the user. The first attempt claimed the stale
    // version 1; the replace must claim the refreshed version 2 (from the 409
    // body), or it would just 409 again.
    await waitFor(() => expect(putBodies).toHaveLength(2))
    expect(putBodies[0]).toMatchObject({
      side_1_points: 12,
      side_2_points: 10,
      expected_version: 1,
    })
    expect(putBodies[1]).toMatchObject({
      side_1_points: 12,
      side_2_points: 10,
      expected_version: 2,
    })
  })
})

describe('ScoreEntry — current user on side 2 (#210)', () => {
  it('POSTs the create with my points flipped into side_2_points', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(inProgressMatchMeSide2()),
      ),
      http.post(
        '*/v1/matches/m-1/games/3/scores/new',
        async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json(
            inProgressMatchMeSide2({
              sides: participantSidesMeSide2({ meWins: 2, oppWins: 1 }),
              games: [
                { id: 'g-1', game_number: 1, score: scoreSide2('s-1', 11, 8) },
                { id: 'g-2', game_number: 2, score: scoreSide2('s-2', 9, 11) },
                { id: 'g-3', game_number: 3, score: scoreSide2('s-3', 11, 4) },
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
    // I'm on side 2, so my 11 lands in `side_2_points` and the opponent's 4 in
    // `side_1_points` — the inverse of the side-1 fixtures. A dropped flip would
    // ship `{ side_1_points: 11, side_2_points: 4 }`, recording my win as a loss.
    expect(captured).toEqual({ side_1_points: 4, side_2_points: 11 })
  })

  it('pre-populates the edit form with my side-2 score and PUTs it back flipped', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(inProgressMatchMeSide2()),
      ),
      http.put('*/v1/matches/m-1/games/1/scores', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(inProgressMatchMeSide2())
      }),
    )

    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 1 })

    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    // Game 1 is stored raw as side_1=8 (opp), side_2=11 (me). The form must
    // show the user-relative values — my 11, not the raw side-1 number.
    await waitFor(() => expect(meInput).toHaveValue('11'))
    expect(oppInput).toHaveValue('8')

    await user.clear(meInput)
    await user.type(meInput, '12')
    await user.clear(oppInput)
    await user.type(oppInput, '10')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 3')).toBeInTheDocument(),
    )
    // Flipped back on the way out: my 12 → side_2_points, opp 10 → side_1_points.
    expect(captured).toEqual({
      side_1_points: 10,
      side_2_points: 12,
      expected_version: 1,
    })
  })
})

describe('ScoreEntry — games past the decider', () => {
  // Best-of-7 swept 4-0: the match is decided at game 4, so games 5-7 can
  // never be played. Mirrors the server's "no games past the decider" guard.
  function decidedBoard(
    overrides: Parameters<typeof matchDetails>[0] = {},
  ) {
    return inProgressMatch({
      best_of: 7,
      games_to_win: 4,
      sides: participantSides({ meWins: 4, oppWins: 0 }),
      games: [
        { id: 'g-1', game_number: 1, score: score('s-1', 11, 2) },
        { id: 'g-2', game_number: 2, score: score('s-2', 11, 2) },
        { id: 'g-3', game_number: 3, score: score('s-3', 11, 2) },
        { id: 'g-4', game_number: 4, score: score('s-4', 11, 2) },
      ],
      current_game: null,
      ...overrides,
    })
  }

  it('mutes the games after the decider in the scoreline', async () => {
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(decidedBoard())),
    )
    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 1 })

    // Games 5-7 render as muted, non-navigable cells…
    expect(
      await screen.findByLabelText('Game 5, not playable'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Game 7, not playable')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /game 5/i })).toBeNull()
    // …while the played games stay navigable for editing.
    expect(
      screen.getByRole('link', { name: /game 2, saved/i }),
    ).toBeInTheDocument()
  })

  it('bounces a direct URL to an unscored game past the decider', async () => {
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(decidedBoard())),
    )
    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 5 })

    expect(await screen.findByText('match-page m-1')).toBeInTheDocument()
  })

  it('keeps the deciding game itself editable', async () => {
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(decidedBoard())),
    )
    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 4 })

    expect(await screen.findByText(/edit game 4 score/i)).toBeInTheDocument()
  })

  it('blocks filling a gap that would decide the match before its last game', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            best_of: 7,
            games_to_win: 4,
            // Side 1 already clinched at game 5 with game 4 left blank — a gappy
            // decided board. Filling game 4 with a side-1 win would move the
            // decider to game 4 while game 5 is scored: impossible.
            sides: participantSides({ meWins: 4, oppWins: 0 }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 2) },
              { id: 'g-2', game_number: 2, score: score('s-2', 11, 2) },
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 2) },
              { id: 'g-5', game_number: 5, score: score('s-5', 11, 2) },
            ],
            current_game: { game_number: 4 },
          }),
        ),
      ),
      http.post('*/v1/matches/m-1/games/4/scores/new', () => {
        posted = true
        return HttpResponse.json(inProgressMatch())
      }),
    )
    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 4 })

    await user.type(
      await screen.findByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(
      screen.getByRole('textbox', { name: 'nguyen.t score' }),
      '2',
    )

    // The actionable message is shown and the write is never fired (the score
    // 11-2 is legal, but it would decide the match at game 4 with game 5 scored).
    expect(
      screen.getByText(/already decided at game 4/i),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(posted).toBe(false)
  })

  it('keeps the next game navigable while the match is undecided', async () => {
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          inProgressMatch({
            best_of: 5,
            sides: participantSides({ meWins: 1, oppWins: 0 }),
            games: [{ id: 'g-1', game_number: 1, score: score('s-1', 11, 2) }],
            current_game: { game_number: 2 },
          }),
        ),
      ),
    )
    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 1 })

    expect(
      await screen.findByRole('link', { name: /game 2, not yet played/i }),
    ).toBeInTheDocument()
  })
})

afterEach(() => {
  // Restore connectivity so the offline test doesn't leak into others.
  onlineManager.setOnline(true)
})
