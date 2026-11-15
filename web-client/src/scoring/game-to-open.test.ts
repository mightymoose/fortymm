import { expect, test } from 'vitest'
import type { BestOf, Score } from './scoring.ts'
import { gameToOpen } from './game-to-open.ts'

function match(bestOf: BestOf, games: Score[]) {
  return { bestOf, games }
}

test.each(['abc', '', '1.5', '2.0', '02', '-1', '0', ' 1', '1e1'])(
  'a game id that isn’t a game number (%j) is not found',
  (gameId) => {
    expect(gameToOpen(gameId, match(5, []))).toEqual({ status: 'not-found' })
  },
)

test('a game above the best of is not found, even when the match is decided', () => {
  expect(gameToOpen('6', match(5, []))).toEqual({ status: 'not-found' })
  expect(gameToOpen('4', match(3, [[11, 1], [11, 2]]))).toEqual({ status: 'not-found' })
})

test('the first unscored game opens', () => {
  expect(gameToOpen('1', match(5, []))).toEqual({ status: 'open', game: 1 })
  expect(gameToOpen('3', match(5, [[11, 7], [9, 11]]))).toEqual({ status: 'open', game: 3 })
})

test('a saved game opens', () => {
  expect(gameToOpen('1', match(5, [[11, 7], [9, 11]]))).toEqual({ status: 'open', game: 1 })
})

test('a game past the first unscored game gives the first unscored game', () => {
  expect(gameToOpen('4', match(5, [[11, 7]]))).toEqual({ status: 'next', game: 2 })
})

test('an unscored game of a decided match gives no game: the dashboard', () => {
  expect(gameToOpen('3', match(3, [[11, 1], [11, 2]]))).toEqual({ status: 'next', game: null })
})

test('a saved game of a decided match opens', () => {
  expect(gameToOpen('2', match(3, [[11, 1], [11, 2]]))).toEqual({ status: 'open', game: 2 })
})
