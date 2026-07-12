import { expect, test, type Page } from '@playwright/test'
import { SEED, ScoreEntryPage } from './page-objects/score-entry.page'

type Score = { id: string; side_1_points: number; side_2_points: number }
type Game = { id: string; game_number: number; score: Score | null }
type Seed = {
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'voided'
  best_of: number
  affects_rating: boolean
  opponent_username: string
  games: Game[]
}

// The seed shape exercised by the score-entry e2e. Mirrors `m-2207` from
// `src/mocks/match-store.ts` (1-1 mid-match), but under a UUID-shaped id (see
// SEED.matchId) so it survives the scoring routes' param-shape guard (#385).
// Per the decouple-scoring refactor, only scored games have rows — the next
// un-scored slot is exposed via current_game.game_number.
function buildSeed(): Seed {
  return {
    id: SEED.matchId,
    status: 'in_progress',
    best_of: 5,
    affects_rating: true,
    opponent_username: SEED.opponentUsername,
    games: [
      {
        id: 'g-2207-1',
        game_number: 1,
        score: { id: 's-2207-1', side_1_points: 11, side_2_points: 8 },
      },
      {
        id: 'g-2207-2',
        game_number: 2,
        score: { id: 's-2207-2', side_1_points: 9, side_2_points: 11 },
      },
    ],
  }
}

function gamesToWin(bestOf: number) {
  return Math.ceil(bestOf / 2)
}

function sideWins(seed: Seed): { s1: number; s2: number } {
  let s1 = 0
  let s2 = 0
  for (const g of seed.games) {
    if (!g.score) continue
    if (g.score.side_1_points > g.score.side_2_points) s1 += 1
    else s2 += 1
  }
  return { s1, s2 }
}

function currentGameNumber(seed: Seed): number | null {
  if (seed.status !== 'in_progress') return null
  const scored = new Set(
    seed.games.filter((g) => g.score !== null).map((g) => g.game_number),
  )
  for (let n = 1; n <= seed.best_of; n += 1) {
    if (!scored.has(n)) return n
  }
  return null
}

function canFinalizeSeed(seed: Seed): boolean {
  if (seed.status !== 'in_progress') return false
  const scored = seed.games.filter((g) => g.score !== null)
  if (scored.length === 0) return false
  const numbers = scored.map((g) => g.game_number).sort((a, b) => a - b)
  if (numbers[numbers.length - 1] > seed.best_of) return false
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) return false
  }
  const target = gamesToWin(seed.best_of)
  const { s1, s2 } = sideWins(seed)
  if (s1 < target && s2 < target) return false
  const ordered = scored.slice().sort((a, b) => a.game_number - b.game_number)
  let wins1 = 0
  let wins2 = 0
  let decidedAt: number | null = null
  for (const g of ordered) {
    if (g.score!.side_1_points > g.score!.side_2_points) wins1 += 1
    else wins2 += 1
    if (decidedAt === null && (wins1 >= target || wins2 >= target)) {
      decidedAt = g.game_number
    }
  }
  return decidedAt === ordered[ordered.length - 1].game_number
}

function projectMatchDetails(seed: Seed) {
  const { s1, s2 } = sideWins(seed)
  const decided = seed.status === 'completed'
  const games = seed.games
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map((g) => ({
      id: g.id,
      game_number: g.game_number,
      score: g.score
        ? {
            id: g.score.id,
            side_1_points: g.score.side_1_points,
            side_2_points: g.score.side_2_points,
            winner_side_number:
              g.score.side_1_points > g.score.side_2_points ? 1 : 2,
          }
        : null,
    }))
  const nextNumber = currentGameNumber(seed)
  return {
    id: seed.id,
    status: seed.status,
    status_label: {
      in_progress: 'Live',
      pending: 'Scheduled',
      completed: 'Final',
      voided: 'Voided',
    }[seed.status],
    best_of: seed.best_of,
    games_to_win: gamesToWin(seed.best_of),
    team_size: 1,
    affects_rating: seed.affects_rating,
    created_at: '2026-05-12T19:00:00Z',
    sides: [
      {
        side_number: 1,
        players: [
          { user_id: 'u-me', username: SEED.meUsername, is_current_user: true },
        ],
        games_won: s1,
        won: decided ? s1 > s2 : null,
        is_current_user_side: true,
      },
      {
        side_number: 2,
        players: [
          {
            user_id: 'u-opp',
            username: seed.opponent_username,
            is_current_user: false,
          },
        ],
        games_won: s2,
        won: decided ? s2 > s1 : null,
        is_current_user_side: false,
      },
    ],
    games,
    current_game: nextNumber !== null ? { game_number: nextNumber } : null,
    can_score: nextNumber !== null,
    can_finalize: canFinalizeSeed(seed),
    // Score entry is always the pre-result scratchpad, so the negotiation is
    // ``live`` (no result posted yet) for every seed these specs build.
    negotiation: {
      viewer_state: 'live',
      your_turn: false,
      standing_result: null,
      prior_result: null,
      diff: null,
    },
  }
}

function validateScore(side1: number, side2: number): string | null {
  const winner = Math.max(side1, side2)
  const loser = Math.min(side1, side2)
  if (winner < 11) return 'The winning side must reach at least 11 points.'
  if (side1 === side2) return 'A game cannot end in a tie.'
  if (winner === 11 && loser > 9) {
    return `At 10–10 the game enters deuce; the winner must lead by 2. ${winner}–${loser} is not a legal final score.`
  }
  if (winner > 11) {
    if (loser < 10) {
      return `A game can only go past 11 points after both sides reach 10. ${winner}–${loser} is not a legal final score.`
    }
    if (winner - loser !== 2) {
      return `In a deuce game the winner leads by exactly 2 points. ${winner}–${loser} is not a legal final score.`
    }
  }
  return null
}

async function installApiMocks(page: Page, seed: Seed): Promise<void> {
  const json = (body: unknown, status = 200) =>
    ({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }) as const

  // `id` is required on the wire (the user menu's "Your profile" link reads
  // it) — MSW is off here, so this stub is the only thing feeding the session.
  await page.route('**/api/v1/session', (route) =>
    route.fulfill(
      json({
        data: {
          user: {
            id: 'e0b7a1c4-3f26-4c9d-9a58-2d61b4f70c83',
            username: SEED.meUsername,
            permissions: [],
          },
        },
      }),
    ),
  )
  await page.route(`**/api/v1/matches/${seed.id}`, (route) =>
    route.fulfill(json(projectMatchDetails(seed))),
  )

  // Per-game scratchpad endpoints (create/update/delete), addressed by game
  // number. No status / side-wins side effects — only the scratchpad rows
  // change.
  await page.route(
    new RegExp(
      `/api/v1/matches/${seed.id}/games/(\\d+)/scores(?:/new)?$`,
    ),
    async (route) => {
      const method = route.request().method()
      const url = new URL(route.request().url())
      const parts = url.pathname.split('/')
      const gamesIdx = parts.indexOf('games')
      const gameNumber = Number(parts[gamesIdx + 1])
      const isCreate = parts[parts.length - 1] === 'new'

      const upsertGame = () => {
        let game = seed.games.find((g) => g.game_number === gameNumber)
        if (!game) {
          game = {
            id: `g-${seed.id}-${gameNumber}`,
            game_number: gameNumber,
            score: null,
          }
          seed.games.push(game)
        }
        return game
      }

      if (method === 'DELETE') {
        const game = seed.games.find((g) => g.game_number === gameNumber)
        if (!game || game.score === null) {
          return route.fulfill(json({ detail: 'Score not found.' }, 404))
        }
        game.score = null
        return route.fulfill(json(projectMatchDetails(seed)))
      }

      const body = JSON.parse(route.request().postData() ?? '{}') as {
        side_1_points: number
        side_2_points: number
      }

      if (method === 'POST' && isCreate) {
        if (gameNumber > seed.best_of) {
          return route.fulfill(
            json(
              {
                detail: `This match is best of ${seed.best_of}; game ${gameNumber} can't exist.`,
              },
              422,
            ),
          )
        }
        const game = upsertGame()
        if (game.score !== null) {
          return route.fulfill(
            json({ detail: 'This game has already been scored.' }, 409),
          )
        }
        const message = validateScore(body.side_1_points, body.side_2_points)
        if (message) return route.fulfill(json({ detail: message }, 422))
        game.score = {
          id: `s-${seed.id}-${gameNumber}`,
          side_1_points: body.side_1_points,
          side_2_points: body.side_2_points,
        }
        return route.fulfill(json(projectMatchDetails(seed), 201))
      }

      if (method === 'PUT') {
        const game = seed.games.find((g) => g.game_number === gameNumber)
        if (!game || game.score === null) {
          return route.fulfill(json({ detail: 'Score not found.' }, 404))
        }
        const message = validateScore(body.side_1_points, body.side_2_points)
        if (message) return route.fulfill(json({ detail: message }, 422))
        game.score = {
          id: game.score.id,
          side_1_points: body.side_1_points,
          side_2_points: body.side_2_points,
        }
        return route.fulfill(json(projectMatchDetails(seed)))
      }

      return route.fulfill(json({ detail: 'Method not allowed.' }, 405))
    },
  )
}

test.describe('Score entry', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, buildSeed())
  })

  test('renders the current game entry with match context', async ({ page }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page)

    await expect(scoreEntry.heading).toHaveText('Enter game 3 score.')
    await expect(scoreEntry.meInput).toBeVisible()
    await expect(scoreEntry.oppInput).toBeVisible()
  })

  test('keeps the save button disabled until a valid score is entered', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page)

    await expect(scoreEntry.saveButton).toBeDisabled()

    // A drawn game is not a valid table tennis result.
    await scoreEntry.enterScores('11', '11')
    await expect(scoreEntry.saveButton).toBeDisabled()

    await scoreEntry.enterScores('11', '7')
    await expect(scoreEntry.saveButton).toBeEnabled()
  })

  test('advances to the next game when the score is saved', async ({ page }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page)

    await scoreEntry.enterScores('11', '7')
    await scoreEntry.saveButton.click()

    // After saving game 3, the next un-scored slot is game 4 (best-of-5).
    await expect(page).toHaveURL(
      new RegExp(`/matches/${SEED.matchId}/games/4/scores/new$`),
    )
    await expect(scoreEntry.heading).toHaveText('Enter game 4 score.')
  })

  test('shows every game in the scoreline with the current game active', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page)

    await expect(scoreEntry.scorelineCells).toHaveCount(5)
    await expect(scoreEntry.activeCell).toContainText('G3')
    // Games already played carry their stored score into the strip.
    await expect(scoreEntry.cell(1)).toContainText('11')
    await expect(scoreEntry.cell(1)).toContainText('8')
  })

  test('clicking a played cell opens its edit route with the score prefilled', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page)

    await scoreEntry.cell(1).click()

    await expect(page).toHaveURL(
      new RegExp(`/matches/${SEED.matchId}/games/1/scores/edit$`),
    )
    await expect(scoreEntry.heading).toHaveText('Edit game 1 score.')
    await expect(scoreEntry.meInput).toHaveValue('11')
    await expect(scoreEntry.oppInput).toHaveValue('8')
  })

  test('blocks an illegal score client-side with an inline hint', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page)

    // 11-10 isn't a legal final score — at 10-10 the game enters deuce. The
    // client catches this so Save stays disabled and never round-trips.
    await scoreEntry.enterScores('11', '10')

    await expect(scoreEntry.saveButton).toBeDisabled()
    await expect(scoreEntry.inlineError).toContainText(/deuce/i)
    await expect(scoreEntry.meInput).toHaveAttribute('aria-invalid', 'true')
    await expect(scoreEntry.oppInput).toHaveAttribute('aria-invalid', 'true')
  })
})
