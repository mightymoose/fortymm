import { expect, test } from 'vitest'
import type { BestOf, Games } from './scoring.ts'
import { gameToOpen } from './game-to-open.ts'

function match(bestOf: BestOf, games: Games) {
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

test('an empty game past the first empty one opens: game 4 with only game 1 saved', () => {
  expect(gameToOpen('4', match(5, [[11, 7]]))).toEqual({ status: 'open', game: 4 })
})

test('the empty game in a gap opens: game 2 with games 1 and 3 saved', () => {
  expect(gameToOpen('2', match(5, [[11, 7], null, [11, 4]]))).toEqual({ status: 'open', game: 2 })
})

test('an unscored game of a decided match is decided: the dashboard', () => {
  expect(gameToOpen('3', match(3, [[11, 1], [11, 2]]))).toEqual({ status: 'decided' })
  expect(gameToOpen('2', match(3, [[11, 1], null, [11, 2]]))).toEqual({ status: 'decided' })
})

test('a saved game of a decided match opens', () => {
  expect(gameToOpen('2', match(3, [[11, 1], [11, 2]]))).toEqual({ status: 'open', game: 2 })
})
