import { expect, test } from 'vitest'
import type { Games } from '../../scoring/scoring.ts'
import type { MatchState } from '../../stores/match.ts'
import type { ScoreLink } from './MatchDetailsScreen.tsx'
import { MatchDetailsScreenPage } from './MatchDetailsScreen.page.tsx'

const inProgress: MatchState = {
  bestOf: 5,
  rated: false,
  games: [
    [11, 7],
    [9, 11],
    [11, 5],
  ],
}

const youWon: MatchState = {
  bestOf: 3,
  rated: true,
  games: [
    [11, 9],
    [11, 8],
  ],
}

const noGames: MatchState = {
  bestOf: 5,
  rated: false,
  games: [],
}

// As the connected component gives it: game n's scoring screen.
const scoreLink: ScoreLink = (game) => ({
  to: '/matches/$matchId/games/$gameId/scores/edit',
  params: { matchId: 'm-1', gameId: String(game) },
})

test('an in-progress match shows both players, the opponent Anonymous, its format, that it goes on with the next game, and the tally in games', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress, scoreLink })

  expect(await page.heading()).toHaveTextContent('You vs Anonymous')
  expect(await page.player('You')).toBeVisible()
  expect(await page.player('Anonymous')).toBeVisible()
  expect(await page.scoreboard()).toHaveAccessibleName('In progress')
  expect(await page.format()).toHaveTextContent(
    /^Best of 5 · Unrated · Game 4 next$/,
  )
  expect(await page.tally()).toHaveTextContent('2 – 1')
})

test('a finished match shows it final with the winner, its format, rated, and the tally', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: youWon, scoreLink })

  expect(await page.heading()).toHaveTextContent('You vs Anonymous')
  expect(await page.scoreboard()).toHaveAccessibleName('Final · You won')
  expect(await page.format()).toHaveTextContent(/^Best of 3 · Rated$/)
  expect(await page.tally()).toHaveTextContent('2 – 0')
})

test('a match the opponent won names the opponent as the winner', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({
    match: {
      ...youWon,
      games: [
        [4, 11],
        [11, 13],
      ],
    },
    scoreLink,
  })

  expect(await page.scoreboard()).toHaveAccessibleName('Final · Anonymous won')
  expect(await page.tally()).toHaveTextContent('0 – 2')
})

test('a match decided by games saved out of order, with a game before them not played, is final', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({
    match: {
      ...youWon,
      games: [null, [11, 5], [11, 3]],
    },
    scoreLink,
  })

  expect(await page.scoreboard()).toHaveAccessibleName('Final · You won')
  expect(await page.tally()).toHaveTextContent('2 – 0')
  expect(await page.game(1)).toHaveAccessibleName('Game 1 – – Not played')
  expect(page.queryScore()).toBeNull()
})

test('a match with no games yet is in progress at 0 – 0, game 1 next, and says no game is saved', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: noGames, scoreLink })

  expect(await page.heading()).toHaveTextContent('You vs Anonymous')
  expect(await page.scoreboard()).toHaveAccessibleName('In progress')
  expect(await page.format()).toHaveTextContent(
    /^Best of 5 · Unrated · Game 1 next$/,
  )
  expect(await page.tally()).toHaveTextContent('0 – 0')
  expect(await page.games()).toHaveTextContent('No games yet.')
  expect(await page.queryGamesTable()).toBeNull()
})

test('each game up to the last saved one shows its score, yours first, and who won it, or that it was not played', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({
    match: { ...inProgress, games: [[11, 7], null, [9, 11]] },
    scoreLink,
  })

  expect(await page.game(1)).toHaveAccessibleName('Game 1 11 7 You')
  expect(await page.game(2)).toHaveAccessibleName('Game 2 – – Not played')
  expect(await page.game(3)).toHaveAccessibleName('Game 3 9 11 Anonymous')
  expect(await page.format()).toHaveTextContent(/Game 2 next$/)
})

test.each<{ name: string; games: Games; next: number }>([
  { name: 'after the saved games', games: inProgress.games, next: 4 },
  { name: 'at the lowest gap', games: [[11, 7], null, [9, 11]], next: 2 },
  { name: 'game 1 with none saved', games: [], next: 1 },
])(
  'while the match is undecided, Score links to the next game’s scoring screen: $name',
  async ({ games, next }) => {
    const page = new MatchDetailsScreenPage()
    page.render({ match: { ...inProgress, games }, scoreLink })

    expect(await page.score()).toHaveAttribute(
      'href',
      `/matches/m-1/games/${next}/scores/edit`,
    )
  },
)

test('a finished match has no Score button', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: youWon, scoreLink })

  await page.heading()
  expect(page.queryScore()).toBeNull()
})

test('the way back is a link to /matches', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress, scoreLink })

  expect(await page.back()).toHaveAttribute('href', '/matches')
})

test('the opponent’s avatar on the scoreboard shows “?”, not an initial, beside Anonymous', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress, scoreLink })

  expect(await page.playerAvatar('Anonymous')).toHaveTextContent(/^\?$/)
  expect(await page.playerAvatar('You')).toHaveTextContent(/^Y$/)
})

test('the games’ table heads the opponent’s column Anonymous, and a game they won says Anonymous won it', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress, scoreLink })

  expect(await page.columnHeaders()).toHaveLength(4)
  expect((await page.columnHeaders())[2]).toHaveTextContent(/^Anonymous$/)
  expect(await page.game(1)).toHaveAccessibleName('Game 1 11 7 You')
  expect(await page.game(2)).toHaveAccessibleName('Game 2 9 11 Anonymous')
})
