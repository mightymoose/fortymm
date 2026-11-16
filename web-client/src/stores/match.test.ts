import { act, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { expect, test, vi } from 'vitest'
import type { MatchToCreate } from './match-source.ts'
import type { Games, Score } from '../scoring/scoring.ts'
import { createMatchMemory } from './match-memory.ts'
import { createMatchStore, matchStore, useMatch } from './match.ts'
import { createMatchesStore, matchesStore } from './matches.ts'

// The match store's logic through its actions, on fresh stores over a fresh
// memory of their own; the last test uses the app's own stores and hook, as a
// connected component will.

function bestOf(length: 1 | 3 | 5 | 7): MatchToCreate {
  return { format: { bestOf: length }, rated: false }
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
      match: { bestOf: 5, rated: false, games: [[11, 7]] },
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

// What the source can do that memory, left alone, never does: wait, and
// refuse. The memory is told to hold or fail its next read or write.

const noGames = { bestOf: 5, rated: false, games: [] }

// Lets everything that can run without the held call run.
const settle = () => new Promise((resolve) => setTimeout(resolve))

test('a save shows in the store only once the write has succeeded', async () => {
  const { memory, store, matchId } = await matchWith(5)
  await store.getState().load(matchId)
  const release = memory.holdNextWrite()

  const saving = store.getState().setGameScore(matchId, 1, [11, 7])
  await settle()

  expect(store.getState().matches[matchId]).toEqual({ status: 'ready', match: noGames })
  release()
  expect(await saving).toEqual({ ok: true })
  expect(store.getState().matches[matchId]).toEqual({
    status: 'ready',
    match: { ...noGames, games: [[11, 7]] },
  })
})

test('a save the device refuses is returned, and the entry stays as it was', async () => {
  const { memory, store, matchId } = await matchWith(5, [[11, 7]])
  const before = store.getState().matches[matchId]
  memory.failNextWrite('storage-unavailable')

  expect(await store.getState().setGameScore(matchId, 2, [9, 11])).toEqual({
    ok: false,
    reason: 'storage-unavailable',
  })

  expect(before).toEqual({ status: 'ready', match: { ...noGames, games: [[11, 7]] } })
  expect(store.getState().matches[matchId]).toBe(before)
})

test('load of a match the device refuses to read is unavailable', async () => {
  const { memory, store, matchId } = await matchWith(5)
  memory.failNextRead('storage-unavailable')

  expect(await store.getState().load(matchId)).toEqual({
    status: 'unavailable',
    reason: 'storage-unavailable',
  })

  expect(store.getState().matches[matchId]).toEqual({
    status: 'unavailable',
    reason: 'storage-unavailable',
  })
})

// The store here never hears of a change, so its copy stays as loaded while
// the memory behind it moves on (as after another tab's write, before its
// announcement arrives).
test('the rules are asked about the match as kept, not the store’s copy', async () => {
  const { memory, matchId } = await matchWith(3)
  const store = createMatchStore({ ...memory, onChange: () => () => {} })
  await store.getState().load(matchId)
  await memory.saveGame(matchId, 1, () => ({ score: [11, 7] }))
  await memory.saveGame(matchId, 2, () => ({ score: [11, 5] }))
  expect(store.getState().matches[matchId]).toEqual({
    status: 'ready',
    match: { ...noGames, bestOf: 3 },
  })

  expect(await store.getState().setGameScore(matchId, 3, [11, 4])).toEqual({
    ok: false,
    reason: 'past-decider',
    message: "The match is already decided; game 3 can't be played.",
  })
})

test('a read that began before a save cannot remove the game', async () => {
  const { memory, store, matchId } = await matchWith(5)
  const release = memory.holdNextRead()

  const reading = store.getState().load(matchId)
  const saving = store.getState().setGameScore(matchId, 1, [11, 7])
  await settle()
  release()
  await Promise.all([reading, saving])

  expect(store.getState().matches[matchId]).toEqual({
    status: 'ready',
    match: { ...noGames, games: [[11, 7]] },
  })
})

// The store here hears only 'all', so only that can bring it the saved game.
test('a change of ‘all’ reads every watched match again and drops the rest', async () => {
  const { memory, matchId: watched } = await matchWith(5)
  const created = await createMatchesStore(memory).getState().createMatch(bestOf(3))
  if (!created.ok) throw new Error('not created')
  const store = createMatchStore({
    ...memory,
    onChange: (listener) =>
      memory.onChange((changed) => {
        if (changed === 'all') listener(changed)
      }),
  })
  await store.getState().load(watched)
  await store.getState().load(created.matchId)
  store.getState().watchMatch(watched)
  await memory.saveGame(watched, 1, () => ({ score: [11, 7] }))

  memory.announceAll()

  await vi.waitFor(() =>
    expect(store.getState().matches).toEqual({
      [watched]: { status: 'ready', match: { ...noGames, games: [[11, 7]] } },
    }),
  )
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
    match: { bestOf: 5, rated: false, games: [[11, 7]] },
    }),
  )
})
