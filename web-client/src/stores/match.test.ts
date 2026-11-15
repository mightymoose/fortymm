import { act, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { expect, test, vi } from 'vitest'
import type { NewMatch } from '../components/new-match/NewMatchScreen.schema.ts'
import type { Games, Score } from '../scoring/scoring.ts'
import { createMatchMemory } from './match-memory.ts'
import { createMatchStore, matchStore, useMatch } from './match.ts'
import { createMatchesStore, matchesStore } from './matches.ts'

// The match store's logic through its actions, on fresh stores over a fresh
// memory of their own; the last test uses the app's own stores and hook, as a
// connected component will.

function bestOf(length: 1 | 3 | 5 | 7): NewMatch {
  return { opponentName: 'Ana', format: { bestOf: length }, rated: false }
}

// A fresh match store, and a match in it with these games saved (a null
// slot left empty), in game order.
async function matchWith(length: 1 | 3 | 5 | 7, games: Games = []) {
  const memory = createMatchMemory()
  const store = createMatchStore(memory)
  const created = await createMatchesStore(memory).getState().createMatch(bestOf(length))
  if (!created.ok) throw new Error('not created')
  for (const [index, score] of games.entries()) {
    if (score === null) continue
    expect(await store.getState().setGameScore(created.matchId, index + 1, score)).toEqual({
      ok: true,
    })
  }
  return { memory, store, matchId: created.matchId }
}

async function gamesOf(store: ReturnType<typeof createMatchStore>, matchId: string) {
  const entry = await store.getState().load(matchId)
  if (entry.status !== 'ready') throw new Error(`match ${entry.status}`)
  return entry.match.games
}

test('a match is scored in any order, cleared in the middle and corrected', async () => {
  const memory = createMatchMemory()
  const matches = createMatchesStore(memory)
  const match = createMatchStore(memory)
  const created = await matches.getState().createMatch({
    opponentName: 'Ana',
    format: { bestOf: 5 },
    rated: false,
  })
  if (!created.ok) throw new Error('not created')
  const { matchId } = created
  const { setGameScore, clearGameScore, load } = match.getState()

  expect(await setGameScore(matchId, 3, [11, 4])).toEqual({ ok: true })
  expect(await setGameScore(matchId, 1, [11, 7])).toEqual({ ok: true })
  expect(await setGameScore(matchId, 2, [9, 11])).toEqual({ ok: true })
  expect(await load(matchId)).toEqual({
    status: 'ready',
    match: {
      opponentName: 'Ana',
      bestOf: 5,
      rated: false,
      games: [
        [11, 7],
        [9, 11],
        [11, 4],
      ],
    },
  })
  expect(await clearGameScore(matchId, 1)).toEqual({ ok: true })
  expect(await setGameScore(matchId, 3, [12, 10])).toEqual({ ok: true })
  expect(await gamesOf(match, matchId)).toEqual([null, [9, 11], [12, 10]])
})

test('a match created with no opponent’s name loads with opponentName null', async () => {
  const memory = createMatchMemory()
  const store = createMatchStore(memory)
  const created = await createMatchesStore(memory)
    .getState()
    .createMatch({ opponentName: null, format: { bestOf: 5 }, rated: false })
  if (!created.ok) throw new Error('not created')

  expect(await store.getState().load(created.matchId)).toEqual({
    status: 'ready',
    match: { opponentName: null, bestOf: 5, rated: false, games: [] },
  })
})

test('load of an id nobody created is missing', async () => {
  const store = createMatchStore(createMatchMemory())

  expect(await store.getState().load(crypto.randomUUID())).toEqual({ status: 'missing' })
})

test('a legal score is saved: a later load shows it', async () => {
  const { store, matchId } = await matchWith(5)

  expect(await store.getState().setGameScore(matchId, 1, [11, 7])).toEqual({ ok: true })

  expect(await gamesOf(store, matchId)).toEqual([[11, 7]])
})

test('setting a saved game’s score again keeps the last one', async () => {
  const { store, matchId } = await matchWith(5, [
    [11, 7],
    [9, 11],
  ])

  expect(await store.getState().setGameScore(matchId, 1, [7, 11])).toEqual({ ok: true })

  expect(await gamesOf(store, matchId)).toEqual([
    [7, 11],
    [9, 11],
  ])
})

// Each refusal the rules give: the games saved, the score asked for, and the
// answer. Nothing changes.
test.each<{ name: string; length: 1 | 3 | 5 | 7; saved: Games; game: number; score: Score; reason: string; message: string }>([
  {
    name: 'an illegal score',
    length: 5,
    saved: [],
    game: 1,
    score: [11, 10],
    reason: 'illegal',
    message: 'At 10–10 the game enters deuce — the winner must lead by 2.',
  },
  {
    name: 'an empty game of a decided match',
    length: 3,
    saved: [[11, 7], null, [11, 8]],
    game: 2,
    score: [11, 9],
    reason: 'past-decider',
    message: "The match is already decided; game 2 can't be played.",
  },
  {
    name: 'a game past the best of',
    length: 3,
    saved: [],
    game: 4,
    score: [11, 7],
    reason: 'past-best-of',
    message: "This match is best of 3; game 4 can't exist.",
  },
])('$name is refused with the rules’ message, and nothing changes', async (refused) => {
  const { store, matchId } = await matchWith(refused.length, refused.saved)

  expect(await store.getState().setGameScore(matchId, refused.game, refused.score)).toEqual({
    ok: false,
    reason: refused.reason,
    message: refused.message,
  })

  expect(await gamesOf(store, matchId)).toEqual(refused.saved)
})

test('game 3 is saved before game 2, leaving game 2 empty', async () => {
  const { store, matchId } = await matchWith(5, [[11, 7]])

  expect(await store.getState().setGameScore(matchId, 3, [11, 4])).toEqual({ ok: true })

  expect(await gamesOf(store, matchId)).toEqual([[11, 7], null, [11, 4]])
})

test('clearGameScore clears the highest saved game', async () => {
  const { store, matchId } = await matchWith(5, [
    [11, 7],
    [9, 11],
  ])

  expect(await store.getState().clearGameScore(matchId, 2)).toEqual({ ok: true })

  expect(await gamesOf(store, matchId)).toEqual([[11, 7]])
})

test('clearGameScore clears the middle game, leaving a gap', async () => {
  const { store, matchId } = await matchWith(5, [
    [11, 7],
    [9, 11],
    [11, 4],
  ])

  expect(await store.getState().clearGameScore(matchId, 2)).toEqual({ ok: true })

  expect(await gamesOf(store, matchId)).toEqual([[11, 7], null, [11, 4]])
})

test('clearGameScore clears a game of a decided match, which reopens its empty games', async () => {
  const { store, matchId } = await matchWith(3, [
    [11, 7],
    [11, 5],
  ])

  expect(await store.getState().clearGameScore(matchId, 1)).toEqual({ ok: true })
  expect(await store.getState().setGameScore(matchId, 3, [4, 11])).toEqual({ ok: true })

  expect(await gamesOf(store, matchId)).toEqual([null, [11, 5], [4, 11]])
})

test('clearGameScore refuses a game that isn’t saved, and nothing changes', async () => {
  const { store, matchId } = await matchWith(5, [[11, 7], null, [11, 4]])

  expect(await store.getState().clearGameScore(matchId, 2)).toEqual({
    ok: false,
    reason: 'not-clearable',
    message: 'Game 2 isn’t saved.',
  })

  expect(await gamesOf(store, matchId)).toEqual([[11, 7], null, [11, 4]])
})

test('an action on a match nobody created is refused', async () => {
  const store = createMatchStore(createMatchMemory())

  expect(await store.getState().setGameScore(crypto.randomUUID(), 1, [11, 7])).toEqual({
    ok: false,
    reason: 'missing',
    message: 'This match isn’t on this device.',
  })
})

test('a watched match’s entry is read again after another store writes it', async () => {
  const { memory, matchId } = await matchWith(5)
  const watching = createMatchStore(memory)
  await watching.getState().load(matchId)
  watching.getState().watchMatch(matchId)

  await createMatchStore(memory).getState().setGameScore(matchId, 1, [11, 7])

  await vi.waitFor(() =>
    expect(watching.getState().matches[matchId]).toEqual({
      status: 'ready',
      match: { opponentName: 'Ana', bestOf: 5, rated: false, games: [[11, 7]] },
    }),
  )
})

test('a match nobody watches is dropped after another store writes it, and read fresh on the next load', async () => {
  const { memory, matchId } = await matchWith(5)
  const unwatched = createMatchStore(memory)
  await unwatched.getState().load(matchId)
  const stop = unwatched.getState().watchMatch(matchId)
  stop()

  await createMatchStore(memory).getState().setGameScore(matchId, 1, [11, 7])

  expect(unwatched.getState().matches[matchId]).toBeUndefined()
  expect(await gamesOf(unwatched, matchId)).toEqual([[11, 7]])
})

// The score is saved through another store over the app's memory (as another
// page's store will be), so only the watch can bring it to this page.
test('a page watching a match shows the new score after an action', async () => {
  const created = await matchesStore.getState().createMatch(bestOf(5))
  if (!created.ok) throw new Error('not created')
  const { matchId } = created
  await matchStore.getState().load(matchId)
  const { result } = renderHook(() => {
    useEffect(() => matchStore.getState().watchMatch(matchId), [])
    return useMatch(matchId)
  })

  await act(() => createMatchStore().getState().setGameScore(matchId, 1, [11, 7]))

  await vi.waitFor(() =>
    expect(result.current).toEqual({
    status: 'ready',
    match: { opponentName: 'Ana', bestOf: 5, rated: false, games: [[11, 7]] },
    }),
  )
})
