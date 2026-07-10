import type { ReactNode } from 'react'
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
  useQueryClient,
} from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { matchDetails } from '@/test/factories'
import type { components } from '@/api/schema'
import { fireScoreSave } from '@/api/matches'
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

// Like `renderScoreEntry`, but also mounts a caller-supplied sibling control
// alongside `ScoreEntry` in the same QueryClient + router. The sibling receives
// the shared QueryClient so it can poke the shared mutation/query cache without
// unmounting the entry screen — e.g. imperatively fail a non-active game's
// scratch save via `fireScoreSave` (the same call the real fire-and-forget save
// makes; #747-F2, the finalize board must fold that failed game in), or
// invalidate/refetch the match underneath a dirty form (#818).
function renderEntryWithSibling({
  gameNumber,
  sibling,
}: {
  gameNumber: number
  sibling: (queryClient: QueryClient) => ReactNode
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const entryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/entry',
    component: function Entry() {
      const qc = useQueryClient()
      return (
        <>
          {sibling(qc)}
          <ScoreEntry
            matchId="m-1"
            gameNumber={gameNumber}
            mode={{ kind: 'create' }}
          />
        </>
      )
    },
  })
  const matchPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <div>match-page m-1</div>,
  })
  const scoringNew = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: () => <div>scoring-new</div>,
  })
  const scoringEdit = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/edit',
    component: () => <div>scoring-edit</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      entryRoute,
      matchPage,
      scoringNew,
      scoringEdit,
    ]),
    history: createMemoryHistory({ initialEntries: ['/entry'] }),
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
    // posting the result for the opponent to accept) instead of /scores/new.
    const user = userEvent.setup()
    let finalizedBody: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(decidingGameMatch()),
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
    // "awaiting acceptance" until the opponent accepts.
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

  it('folds a FAILED scratch save on a non-active game into the posted board (#747-F2)', async () => {
    // Bo3. G1 persisted (I won 11-8). G2's save FAILED (I lost 9-11) and lives
    // only in the mutation cache — never persisted. I'm now on G3 and win it
    // 11-7, so the true board is 2-1 for me. The finalize board must fold in the
    // failed G2: post 2-1, not the 2-0 that dropping G2 would compact into
    // (which would erase my opponent's game).
    const user = userEvent.setup()
    let finalizedBody: unknown = null
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'in_progress',
            status_label: 'Live',
            best_of: 3,
            games_to_win: 2,
            affects_rating: true,
            sides: participantSides({ meWins: 1, oppWins: 0 }),
            games: [{ id: 'g-1', game_number: 1, score: score('s-1', 11, 8) }],
            current_game: { game_number: 2 },
            can_score: true,
            can_finalize: false,
          }),
        ),
      ),
      // G2's scratch save fails (500) — it never persists, so it only ever
      // exists as a failed mutation in the cache.
      http.post('*/v1/matches/m-1/games/2/scores/new', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
      http.post('*/v1/matches/m-1/results', async ({ request }) => {
        finalizedBody = await request.json()
        return HttpResponse.json(
          matchDetails({
            id: 'm-1',
            status: 'completed',
            status_label: 'Final',
            best_of: 3,
            games_to_win: 2,
            sides: participantSides({ meWins: 2, oppWins: 1, meWon: true }),
            games: [
              { id: 'g-1', game_number: 1, score: score('s-1', 11, 8) },
              { id: 'g-2', game_number: 2, score: score('s-2', 9, 11) },
              { id: 'g-3', game_number: 3, score: score('s-3', 11, 7) },
            ],
            current_game: null,
            can_score: false,
            can_finalize: false,
          }),
          { status: 201 },
        )
      }),
    )

    renderEntryWithSibling({
      gameNumber: 3,
      sibling: (qc) => (
        <button
          type="button"
          onClick={() =>
            fireScoreSave(qc, 'm-1', 2, {
              side_1_points: 9,
              side_2_points: 11,
            })
          }
        >
          fail game 2
        </button>
      ),
    })

    // Seed the failed G2 save into the shared mutation cache.
    await user.click(await screen.findByRole('button', { name: 'fail game 2' }))
    // The "Not saved" cell confirms the failure landed before we finalize.
    await screen.findByText('Not saved')

    const meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.type(meInput, '11')
    await user.type(oppInput, '7')

    // G3 clinches a 2-1 board (G1 me, G2 opp, G3 me), so the button finalizes.
    const postBtn = await screen.findByRole('button', { name: /post result/i })
    await user.click(postBtn)

    await waitFor(() =>
      expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
    )
    // The failed G2 (9-11, my loss) is present — the board is 2-1, not the 2-0
    // that omitting G2 would have compacted and posted.
    expect(finalizedBody).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 8 },
        { game_number: 2, side_1_points: 9, side_2_points: 11 },
        { game_number: 3, side_1_points: 11, side_2_points: 7 },
      ],
    })
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
        HttpResponse.json(decidingGameMatch()),
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
        HttpResponse.json(decidingGameMatch()),
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

function renderScoringApp(
  initialPath: string,
  { stubEditRoute = false }: { stubEditRoute?: boolean } = {},
) {
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
    // `stubEditRoute` lands the edit route inert (no redirect/loop) instead of
    // mounting the real edit ScoreEntry: a test whose pre-fix bypass navigates
    // here can then cleanly assert we did NOT arrive, rather than busy-looping
    // against a real edit screen that bypasses the same banner.
    component: stubEditRoute
      ? () => <div>scoring-edit</div>
      : function EditEntry() {
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

// A match sitting on the deciding game: 2–0 with games 1 and 2 scored, so the
// next entry (game 3) can finish the match.
function decidingGameMatch() {
  return inProgressMatch({
    sides: participantSides({ meWins: 2, oppWins: 0 }),
    games: [
      { id: 'g-1', game_number: 1, score: score('s-1', 11, 4) },
      { id: 'g-2', game_number: 2, score: score('s-2', 11, 6) },
    ],
    current_game: { game_number: 3 },
  })
}

// The finalized MatchDetails a successful POST /results returns: a completed
// best-of-5 the current user swept 3–0.
function completedMatch() {
  return matchDetails({
    id: 'm-1',
    status: 'completed',
    status_label: 'Final',
    best_of: 5,
    games_to_win: 3,
    sides: participantSides({ meWins: 3, oppWins: 0, meWon: true }),
    current_game: null,
    can_score: false,
    can_finalize: false,
  })
}

// Like `renderScoreEntry`, but mounts a sibling "refetch match" button that
// invalidates the match query — so a test can make the server's answer change
// underneath a mounted, dirty score-entry (e.g. the match completes while the
// user is typing) and drive the resulting refetch, then assert on the
// declarative `<Navigate>` guard redirect that fires from the fresh data.
// Drives an edit whose first save loses the version race and 409s, opens the
// conflict, and taps "Replace with my score" — the re-fire lands on the fresh
// version and clears the conflict without navigating. Returns the harness so
// each caller can assert on its own distinct tail.
async function renderReplaceConflict() {
  const user = userEvent.setup()
  const putBodies: Array<Record<string, number>> = []
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

  // The 409 advances us fire-and-forget; open the conflict to review it.
  await screen.findByRole('heading', { name: /enter game 3 score/i })
  await user.click(
    await screen.findByRole('button', { name: /review game 1/i }),
  )
  await screen.findByRole('heading', { name: /edit game 1 score/i })

  // Replace re-fires with the fresh version — this path does NOT navigate.
  await user.click(
    screen.getByRole('button', { name: /replace with my score/i }),
  )
  await waitFor(() => expect(putBodies).toHaveLength(2))

  return { user, putBodies }
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
        // Bo5, 2-0 on the board — an 11-3 win in game 3 clinches at 3-0.
        HttpResponse.json(decidingGameMatch()),
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
        HttpResponse.json(decidingGameMatch()),
      ),
      http.post('*/v1/matches/m-1/games/3/scores/new', () => {
        scoreSaveCalls += 1
        return HttpResponse.error()
      }),
      http.post('*/v1/matches/m-1/results', async ({ request }) => {
        resultsBody = await request.json()
        return HttpResponse.json(completedMatch(), { status: 201 })
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
        HttpResponse.json(decidingGameMatch()),
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
        HttpResponse.json(decidingGameMatch()),
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
  // `data.games`, or it bounces back to game 1. Bo3 split G1 win / G2 loss so
  // the board is still 1-1 after two offline games (no early clinch): we must
  // advance G1→G2→G3 counting both failed saves. G3's win then finalizes the
  // true 2-1 board — which, per #747-F2, must carry the FAILED game 2 that
  // score-entry's board now folds in (dropping it would post a wrong 2-0).
  it('offline: advance through every game counting failed saves, then finalize the true 2-1 board', async () => {
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
            sides: participantSides({ meWins: 2, oppWins: 1, meWon: true }),
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

    // Game 1 offline (my win) → fails, advances to game 2.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '9')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 2 score/i })

    // Game 2 offline (my loss) → still 1-1, undecided, so it must advance to
    // game 3 (NOT bounce back to game 1 — the prediction has to count both
    // failed scratch saves, which is the bug this guards).
    await user.type(screen.getByRole('textbox', { name: 'rita.kovac score' }), '9')
    await user.type(
      screen.getByRole('textbox', { name: 'nguyen.t score' }),
      '11',
    )
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // Both offline games sit in the strip.
    expect(
      screen.getByRole('link', { name: /game 1 didn't save, 11 to 9/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /game 2 didn't save, 9 to 11/i }),
    ).toBeInTheDocument()

    // Back online, enter the deciding game 3. Its win clinches a 2-1 board — and
    // the finalize board must fold in the FAILED game 2 (#747-F2), posting 2-1
    // rather than dropping G2 and compacting to a wrong 2-0.
    onlineManager.setOnline(true)
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '7')
    await user.click(screen.getByRole('button', { name: /post result/i }))
    await waitFor(() =>
      expect(screen.getByText('match-page')).toBeInTheDocument(),
    )
    expect(resultsBody).toEqual({
      games: [
        { game_number: 1, side_1_points: 11, side_2_points: 9 },
        { game_number: 2, side_1_points: 9, side_2_points: 11 },
        { game_number: 3, side_1_points: 11, side_2_points: 7 },
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

  it('does not prompt after finalize succeeds and hops to the match page (#818)', async () => {
    // Happy-path guard: the dirty deciding score would trip the blocker, but
    // finalize's onSuccess hop opts out via `ignoreBlocker` — we must land on
    // the match page with no leave prompt. Passes before and after the fix; it
    // catches an `ignoreBlocker` dropped from the finalize hop (ADR 0014).
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(decidingGameMatch()),
      ),
      http.post('*/v1/matches/m-1/results', () =>
        HttpResponse.json(completedMatch(), { status: 201 }),
      ),
    )

    renderScoreEntry({ kind: 'create', matchId: 'm-1', gameNumber: 3 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    await user.type(meInput, '11')
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '3')

    await user.click(screen.getByRole('button', { name: /post result/i }))
    await waitFor(() =>
      expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/leave without saving/i)).not.toBeInTheDocument()
  })

  it('does not prompt after clearing a dirty edit and hopping to the empty entry (#818)', async () => {
    // Happy-path guard for the clear-then-recreate hop. The form is dirty when
    // Clear fires, so without `ignoreBlocker` the edit→new hop would be caught.
    // Passes before and after the fix (the old latch armed this path too); the
    // pre-existing clear test never typed a change, so `isDirty` was false and
    // it never exercised the bypass.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.delete('*/v1/matches/m-1/games/1/scores', () =>
        HttpResponse.json(inProgressMatch()),
      ),
    )

    renderScoreEntry({ kind: 'edit', matchId: 'm-1', gameNumber: 1 })
    const meInput = await screen.findByRole('textbox', {
      name: 'rita.kovac score',
    })
    await waitFor(() => expect(meInput).toHaveValue('11'))

    // Make the form dirty, then clear.
    await user.clear(meInput)
    await user.type(meInput, '12')
    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: /clear game/i }))

    await waitFor(() =>
      expect(screen.getByText('scoring-new m-1 1')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/leave without saving/i)).not.toBeInTheDocument()
  })

  it('regression: an offline deciding-game save, then a further edit + in-app nav, still warns (#818)', async () => {
    // The #818 repro. Offline the deciding game stores as a failed scratch save
    // and we stay put (finalize banner). A further edit keeps the form dirty, so
    // tapping another game in the scoreline MUST warn. The old always-armed
    // latch — armed by `onSubmit` before the offline branch and never cleared —
    // silently waved this through, discarding the deciding score. Fails against
    // the pre-fix component.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () =>
        HttpResponse.json(decidingGameMatch()),
      ),
      // Offline → the deciding-game scratchpad save rejects with a network error.
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.error(),
      ),
    )

    renderScoringApp('/matches/m-1/games/3/scores/new')
    await screen.findByRole('heading', { name: /enter game 3 score/i })
    onlineManager.setOnline(false)

    const meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.type(meInput, '11')
    await user.type(oppInput, '3')

    // Deciding game offline → stored as a failed scratch save; we stay on game 3
    // with the finalize banner.
    await user.click(screen.getByRole('button', { name: /post result/i }))
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('These scores finish the match.')

    // A further edit over the failed score keeps the form dirty.
    await user.clear(oppInput)
    await user.type(oppInput, '5')

    // Leaving in-app (tapping another saved game) must warn.
    await user.click(screen.getByRole('link', { name: /game 1, saved/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/leave without saving/i)
  })

  it('regression: after "Replace with my score", a further edit + in-app nav still warns (#818)', async () => {
    // The second dead-guard path. `overwriteWithMyScore` never navigates, yet
    // the pre-fix code armed the latch inside it — from then on the guard was
    // dead for this component instance. A further edit here is genuinely unsaved,
    // so an in-app navigation MUST warn. Fails against the pre-fix component.
    const { user } = await renderReplaceConflict()

    // The replace succeeds and clears the conflict without navigating.
    await waitFor(() =>
      expect(
        screen.queryByText(/this game was saved by someone else/i),
      ).not.toBeInTheDocument(),
    )

    // A further edit keeps the form dirty; leaving in-app must still warn.
    const meAfter = screen.getByRole('textbox', { name: 'rita.kovac score' })
    await user.clear(meAfter)
    await user.type(meAfter, '9')

    await user.click(screen.getByRole('link', { name: /game 2, saved/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/leave without saving/i)
  })

  it('regression: posting the result from the save banner after a multi-game offline failure does not warn (#818)', async () => {
    // The child-navigation path the #818 audit missed (ADR 0014). The audit
    // patched the three navigate() calls in score-entry.tsx but SaveBanner —
    // rendered *inside* ScoreEntryInner — has two of its own, guarded by the
    // same still-mounted blocker. The prior #818 tests all used a SINGLE failed
    // decider game, where `otherFailed` is empty, `decidedHere` is true, and the
    // banner's own "Post result" button never renders (the main button owns
    // finalizing) — so this path shipped untested and broken.
    //
    // Here games 1 AND 2 also fail offline, so `otherFailed` is non-empty,
    // `decidedHere` is false, and the banner renders its OWN "Post result"
    // button. Clicking it finalizes and hops to the match page — an
    // app-initiated navigation that must bypass the still-dirty unsaved-input
    // guard. Fails against the pre-fix save-banner (the hop had no
    // `ignoreBlocker`, so the guard caught it).
    const user = userEvent.setup()
    const cleanMatch = inProgressMatch({
      best_of: 5,
      games_to_win: 3,
      affects_rating: true,
      sides: participantSides({ meWins: 0, oppWins: 0 }),
      games: [],
      current_game: { game_number: 1 },
    })
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(cleanMatch)),
      // Offline → every scratch save rejects with a network error.
      http.post('*/v1/matches/m-1/games/:n/scores/new', () =>
        HttpResponse.error(),
      ),
      http.post('*/v1/matches/m-1/results', () =>
        HttpResponse.json(completedMatch(), { status: 201 }),
      ),
    )

    renderScoringApp('/matches/m-1/games/1/scores/new')
    await screen.findByRole('heading', { name: /enter game 1 score/i })
    onlineManager.setOnline(false)

    // Game 1 offline (my win) → fails, advances to game 2.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '9')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 2 score/i })

    // Game 2 offline (my win) → still 2-0, undecided in Bo5, advances to game 3.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '9')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // Game 3 is the decider (2-0 on the recorded board). Typing the clinching
    // win makes isDirty true. Still offline, the main "Post result" stores a
    // scratch save and keeps us on game 3 (the `wouldFinalize` early return);
    // isDirty stays stored-true (a folded-baseline derivation would read false —
    // ADR 0014).
    const meInput = screen.getByRole('textbox', { name: 'rita.kovac score' })
    const oppInput = screen.getByRole('textbox', { name: 'nguyen.t score' })
    await user.type(meInput, '11')
    await user.type(oppInput, '9')
    await user.click(screen.getByRole('button', { name: /post result/i }))

    // All three games now sit as failed scratch saves deciding a 3-0 board, and
    // because games 1 & 2 also failed (`otherFailed` non-empty) the banner is
    // NOT `decidedHere`: it renders its OWN "Post result" button. Reaching this
    // proves we hit the previously-uncovered path.
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('These scores finish the match.')
    const bannerPost = within(banner).getByRole('button', {
      name: /post result/i,
    })
    expect(bannerPost).toBeInTheDocument()

    // Back online, post the result from the banner. Its onSuccess hop to the
    // match page is app-initiated, so it must bypass the still-dirty guard (ADR
    // 0014) — land on the match page with no "leave without saving" prompt.
    onlineManager.setOnline(true)
    // fireEvent (not user.click): against the pre-fix banner this hop is blocked,
    // and the blocked finalize + completed-redirect `<Navigate>` busy-loops —
    // which would leave user-event's `act()` waiting forever and hang the test.
    // fireEvent returns synchronously, so the assertion below is what surfaces
    // the regression (it lands on the match page only once the hop bypasses the
    // guard).
    fireEvent.click(bannerPost)

    // Explicit timeout: setup.ts sets `asyncUtilTimeout: 5000`, which equals
    // vitest's default `testTimeout: 5000`, so a bare waitFor here shares the
    // test's whole budget. `fireEvent` returns synchronously, so the async
    // finalize → onSuccess navigate chain runs inside this window; when it
    // flushes slowly the two timers fire at the same boundary and the test dies
    // with an opaque "Test timed out" instead of a diagnosable "match-page".
    await waitFor(
      () => expect(screen.getByText('match-page')).toBeInTheDocument(),
      { timeout: 2000 },
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/leave without saving/i)).not.toBeInTheDocument()
  })

  it('regression: clicking "Review game N" in the conflict banner with unsaved typing still warns (#818)', async () => {
    // The positive control the audit lacked. ConflictReviewBanner's "Review
    // game N" button is a USER-initiated hop — the same gesture as tapping a
    // scoreline <Link> — so it must NOT bypass the dirty-form guard (ADR 0014).
    // The banner renders inside ScoreEntryInner, whose still-mounted blocker
    // catches this navigation. A prior misdiagnosis added `ignoreBlocker: true`
    // here, which silently discarded typed input.
    //
    // Harness: a REAL /scores/new route (the active game) but a STUB /scores/edit
    // route — the review destination. Game 3's create save 409s as a conflict;
    // fire-and-forget advances to game 4, where the ConflictReviewBanner renders
    // "Review game 3". Stubbing the edit route is deliberate: against the pre-fix
    // banner the bypass navigates there, and a stub lands inert so
    // `findByRole('alertdialog')` cleanly rejects (no dialog — we navigated)
    // instead of busy-looping on a real edit screen.
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
      http.post('*/v1/matches/m-1/games/3/scores/new', () =>
        HttpResponse.json(
          {
            detail: {
              message:
                'This game was saved by someone else while you were editing.',
              committed_score: null,
            },
          },
          { status: 409 },
        ),
      ),
    )

    // Stub edit route (the review destination) so the pre-fix bypass lands
    // inert (no redirect/loop) — see `renderScoringApp`'s `stubEditRoute`.
    renderScoringApp('/matches/m-1/games/3/scores/new', { stubEditRoute: true })

    await screen.findByRole('heading', { name: /enter game 3 score/i })
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )
    await user.type(screen.getByRole('textbox', { name: 'nguyen.t score' }), '4')
    await user.click(screen.getByRole('button', { name: /save game & next/i }))

    // Fire-and-forget advances to game 4; game 3's rejected save surfaces as a
    // conflict to review (the active game 4 is excluded from the banner).
    await screen.findByRole('heading', { name: /enter game 4 score/i })
    const reviewBtn = await screen.findByRole('button', {
      name: /review game 3/i,
    })

    // Dirty the ACTIVE game (4) with FRESH typing — game 4 has no failed save of
    // its own (the conflict is on game 3), so its dirty baseline starts clean
    // and this input is unambiguously user-caused, not stale-true.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )

    // Clicking Review is a user-initiated hop — it must warn, not silently leave.
    // fireEvent (not user.click): the two outcomes are mutually exclusive — the
    // fixed banner blocks (dialog appears, we stay put) while the pre-fix banner
    // bypasses (navigates to the stub edit route, no dialog). Wait for whichever
    // resolves, then discriminate: the fixed banner shows the dialog and does NOT
    // reach "scoring-edit"; the pre-fix banner reaches "scoring-edit" and getByRole
    // below fails with a fast, clean "no alertdialog".
    fireEvent.click(reviewBtn)
    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog') ?? screen.queryByText('scoring-edit'),
      ).not.toBeNull(),
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /leave without saving/i,
    )
    // The guard held — we did NOT navigate to game 3's (stub) edit screen.
    expect(screen.queryByText('scoring-edit')).not.toBeInTheDocument()
  })

  it('regression: a match completed underneath a dirty form bounces to match detail without warning (#818)', async () => {
    // The declarative-redirect arm of #818. The user is typing a score when the
    // match completes on the server (opponent finalized, a late refetch, etc.).
    // The next `useMatch` refetch returns `completed`, so score-entry's
    // `<Navigate>` guard bounces to the read-only match page. That redirect is
    // app-initiated (computed from server data, no user gesture), so it must
    // bypass the dirty-form guard via `ignoreBlocker`; omitting it doesn't just
    // prompt — a blocked `<Navigate>` re-fires and wedges the screen (ADR 0014).
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(inProgressMatch())),
    )

    renderEntryWithSibling({
      gameNumber: 3,
      sibling: (qc) => (
        <button type="button" onClick={() => qc.invalidateQueries()}>
          refetch match
        </button>
      ),
    })
    await screen.findByRole('heading', { name: /enter game 3 score/i })

    // Fresh user typing — genuinely dirties the form (game 3 is unscored, so
    // the baseline is empty and this diverges from it). Not a stale-true
    // isDirty from a failed save.
    await user.type(
      screen.getByRole('textbox', { name: 'rita.kovac score' }),
      '11',
    )

    // The match completes on the server underneath the dirty form.
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(completedMatch())),
    )

    // fireEvent (not user.click): against the pre-fix component the completed
    // `<Navigate>` is blocked and busy-loops, which would leave user-event's
    // `act()` waiting forever and hang the test. fireEvent returns synchronously,
    // so the `waitFor` below governs the bound and surfaces the regression.
    fireEvent.click(screen.getByRole('button', { name: /refetch match/i }))

    // The redirect lands us on the read-only match page — no leave prompt.
    // Explicit timeout: setup.ts sets `asyncUtilTimeout: 5000`, which equals
    // vitest's default `testTimeout: 5000`, so a bare waitFor here shares the
    // test's whole budget. `fireEvent` returns synchronously, so the async
    // invalidate → refetch → <Navigate> chain runs inside this window; when it
    // flushes slowly the two timers fire at the same boundary and the test dies
    // with an opaque "Test timed out" instead of a diagnosable "match-page m-1".
    await waitFor(
      () => expect(screen.getByText('match-page m-1')).toBeInTheDocument(),
      { timeout: 2000 },
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/leave without saving/i)).not.toBeInTheDocument()
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
    const { putBodies } = await renderReplaceConflict()

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
