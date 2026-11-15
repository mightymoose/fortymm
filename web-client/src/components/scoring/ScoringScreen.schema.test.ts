import { expect, test } from 'vitest'
import type { Score } from '../../scoring/scoring.ts'
import {
  bothScoresMessage,
  refusalOf,
  scoreDefaults,
  scoreSchema,
} from './ScoringScreen.schema.ts'

const game1 = scoreSchema({ bestOf: 5, games: [], game: 1 })

function issues(result: ReturnType<typeof game1.safeParse>) {
  return result.error?.issues.map(({ path, message }) => ({ path, message }))
}

test('a legal score is handed on as numbers, yours first', () => {
  expect(game1.parse({ yours: '11', theirs: '7' })).toEqual([11, 7])
  expect(game1.parse({ yours: '9', theirs: '11' })).toEqual([9, 11])
})

test.each([
  ['11', '10', 'At 10–10 the game enters deuce — the winner must lead by 2.'],
  ['12', '9', 'A game can only go past 11 once both sides reach 10.'],
  ['10', '10', 'The winning side must reach at least 11 points.'],
  ['11', '11', 'A game cannot end in a tie.'],
  ['111', '9', 'Each side can score at most 99 points.'],
])('%s–%s is refused with the rules’ reason, once, on the form', (yours, theirs, reason) => {
  expect(issues(game1.safeParse({ yours, theirs }))).toEqual([
    { path: ['root'], message: reason },
  ])
  expect(refusalOf(game1, { yours, theirs })).toBe(reason)
})

test('both fields empty: “Enter both scores”, on each', () => {
  expect(issues(game1.safeParse({ yours: '', theirs: '' }))).toEqual([
    { path: ['yours'], message: bothScoresMessage },
    { path: ['theirs'], message: bothScoresMessage },
  ])
})

test('one field empty: “Enter both scores”, on the empty one only', () => {
  expect(issues(game1.safeParse({ yours: '11', theirs: '' }))).toEqual([
    { path: ['theirs'], message: bothScoresMessage },
  ])
})

test('a legal score, or one with a field empty, is no refusal', () => {
  expect(refusalOf(game1, { yours: '11', theirs: '9' })).toBeUndefined()
  expect(refusalOf(game1, { yours: '11', theirs: '' })).toBeUndefined()
})

test('a legal score the match can’t take there is refused with the rules’ message', () => {
  // Best of 3, won 2–0: there is no game 3 to save.
  const decided: Score[] = [
    [11, 5],
    [11, 5],
  ]
  const game3 = scoreSchema({ bestOf: 3, games: decided, game: 3 })

  expect(issues(game3.safeParse({ yours: '11', theirs: '5' }))?.[0]).toEqual({
    path: ['root'],
    message: "The match was already decided at game 2; game 3 can't be played.",
  })
})

test('the pad opens empty for a new game, with the saved score for a saved one', () => {
  expect(scoreDefaults(undefined)).toEqual({ yours: '', theirs: '' })
  expect(scoreDefaults([11, 7])).toEqual({ yours: '11', theirs: '7' })
})
