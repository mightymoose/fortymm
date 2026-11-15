import { expect, test, vi } from 'vitest'
import type { NewMatch } from '../components/new-match/NewMatchScreen.schema.ts'
import { createMatchMemory } from './match-memory.ts'
import { createMatchStore } from './match.ts'
import { createMyMatchesStore } from './my-matches.ts'

// The list store's logic through its actions, on fresh stores over a fresh
// memory of their own (the match store reads the same memory).
function fresh() {
  const memory = createMatchMemory()
  return { myMatches: createMyMatchesStore(memory), matches: createMatchStore(memory) }
}

const againstAna: NewMatch = {
  opponentName: 'Ana',
  format: { bestOf: 5 },
  rated: true,
}
const againstBo: NewMatch = {
  opponentName: 'Bo',
  format: { bestOf: 3 },
  rated: false,
}

test('createMatch gives an id, and the match loads with its name, length and rated, and no games', async () => {
  const { myMatches, matches } = fresh()

  const created = await myMatches.getState().createMatch(againstAna)

  expect(created).toEqual({ ok: true, matchId: expect.any(String) })
  if (!created.ok) throw new Error('not created')
  expect(await matches.getState().load(created.matchId)).toEqual({
    status: 'ready',
    match: { opponentName: 'Ana', bestOf: 5, rated: true, games: [] },
  })
})

test('two matches get different ids, and the list has both, newest first', async () => {
  const { myMatches } = fresh()

  const first = await myMatches.getState().createMatch(againstAna)
  const second = await myMatches.getState().createMatch(againstBo)
  await myMatches.getState().load()

  if (!first.ok || !second.ok) throw new Error('not created')
  expect(first.matchId).not.toBe(second.matchId)
  expect(myMatches.getState().myMatches).toEqual({
    status: 'ready',
    matches: [
      { matchId: second.matchId, opponentName: 'Bo', bestOf: 3, rated: false },
      { matchId: first.matchId, opponentName: 'Ana', bestOf: 5, rated: true },
    ],
  })
})

test('the list is unread until its first load', () => {
  const { myMatches } = fresh()

  expect(myMatches.getState().myMatches).toEqual({ status: 'unread' })
})

test('a watched list is read again after another store writes a match', async () => {
  const memory = createMatchMemory()
  const watched = createMyMatchesStore(memory)
  const other = createMyMatchesStore(memory)
  await watched.getState().load()
  watched.getState().watchMyMatches()

  const created = await other.getState().createMatch(againstAna)

  if (!created.ok) throw new Error('not created')
  await vi.waitFor(() =>
    expect(watched.getState().myMatches).toEqual({
      status: 'ready',
      matches: [{ matchId: created.matchId, opponentName: 'Ana', bestOf: 5, rated: true }],
    }),
  )
})

test('a list nobody watches goes back to unread after another store writes a match', async () => {
  const memory = createMatchMemory()
  const unwatched = createMyMatchesStore(memory)
  const other = createMyMatchesStore(memory)
  await unwatched.getState().load()
  const stop = unwatched.getState().watchMyMatches()
  stop()

  await other.getState().createMatch(againstAna)

  expect(unwatched.getState().myMatches).toEqual({ status: 'unread' })
})
