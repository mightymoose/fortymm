import { expect, test } from 'vitest'
import type { MatchDetails } from './MatchDetailsScreen.tsx'
import { MatchDetailsScreenPage } from './MatchDetailsScreen.page.tsx'

const inProgress: MatchDetails = {
  opponentName: 'Ana',
  format: { bestOf: 5, points: 11 },
  rated: false,
  games: [
    { you: 11, opponent: 7 },
    { you: 9, opponent: 11 },
    { you: 11, opponent: 5 },
  ],
}

const youWon: MatchDetails = {
  opponentName: 'Ben',
  format: { bestOf: 3, points: 11 },
  rated: true,
  games: [
    { you: 11, opponent: 9 },
    { you: 11, opponent: 8 },
  ],
}

const noGames: MatchDetails = {
  opponentName: 'Chen',
  format: { bestOf: 5, points: 11 },
  rated: false,
  games: [],
}

const scoreLink = '/matches/sample-1/games/4/scores/edit'

test('an in-progress match shows both players, its format, that it goes on with the next game, and the tally in games', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress })

  expect(await page.heading()).toHaveTextContent('You vs Ana')
  expect(await page.player('You')).toBeVisible()
  expect(await page.player('Ana')).toBeVisible()
  expect(await page.scoreboard()).toHaveAccessibleName('In progress')
  expect(await page.format()).toHaveTextContent(
    'Best of 5 · Unrated · Game 4 next',
  )
  expect(await page.tally()).toHaveTextContent('2 – 1')
})

test('a finished match shows it final with the winner, its format, rated, and the tally', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: youWon })

  expect(await page.heading()).toHaveTextContent('You vs Ben')
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
        { you: 4, opponent: 11 },
        { you: 11, opponent: 13 },
      ],
    },
  })

  expect(await page.scoreboard()).toHaveAccessibleName('Final · Ben won')
  expect(await page.tally()).toHaveTextContent('0 – 2')
})

test('a match with no games yet is in progress at 0 – 0, game 1 next, and says no game is saved', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: noGames })

  expect(await page.heading()).toHaveTextContent('You vs Chen')
  expect(await page.scoreboard()).toHaveAccessibleName('In progress')
  expect(await page.format()).toHaveTextContent(
    'Best of 5 · Unrated · Game 1 next',
  )
  expect(await page.tally()).toHaveTextContent('0 – 0')
  expect(await page.games()).toHaveTextContent('No games yet.')
  expect(await page.queryGamesTable()).toBeNull()
})

test('each saved game shows its score, yours first, and who won it, in the order played', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress })

  expect(await page.game(1)).toHaveAccessibleName('Game 1 11 7 You')
  expect(await page.game(2)).toHaveAccessibleName('Game 2 9 11 Ana')
  expect(await page.game(3)).toHaveAccessibleName('Game 3 11 5 You')
  expect(await page.queryGamesTable()).not.toBeNull()
})

test('with a scoring link and the match going on, Score links to it', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress, scoreLink })

  expect(await page.score()).toHaveAttribute('href', scoreLink)
})

test('without a scoring link there is no Score button', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress })

  await page.heading()
  expect(page.queryScore()).toBeNull()
})

test('a finished match has no Score button, even with a scoring link', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: youWon, scoreLink })

  await page.heading()
  expect(page.queryScore()).toBeNull()
})

test('the way back is a link to /matches', async () => {
  const page = new MatchDetailsScreenPage()
  page.render({ match: inProgress })

  expect(await page.back()).toHaveAttribute('href', '/matches')
})
