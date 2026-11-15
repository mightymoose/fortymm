import { expect, test, vi } from 'vitest'
import type { NewMatch } from '../components/new-match/NewMatchScreen.schema.ts'
import { createMatchMemory } from './match-memory.ts'
import { createMatchStore } from './match.ts'
import { createMatchesStore } from './matches.ts'

// The list store's logic through its actions, on fresh stores over a fresh
// memory of their own (the match store reads the same memory).
function fresh() {
  const memory = createMatchMemory()
  return { matches: createMatchesStore(memory), match: createMatchStore(memory) }
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
  const { matches, match } = fresh()

  const created = await matches.getState().createMatch(againstAna)

  expect(created).toEqual({ ok: true, matchId: expect.any(String) })
  if (!created.ok) throw new Error('not created')
  expect(await match.getState().load(created.matchId)).toEqual({
    status: 'ready',
    match: { opponentName: 'Ana', bestOf: 5, rated: true, games: [] },
  })
})

test('two matches get different ids, and the list has both, newest first', async () => {
  const { matches } = fresh()

  const first = await matches.getState().createMatch(againstAna)
  const second = await matches.getState().createMatch(againstBo)
  await matches.getState().load()

  if (!first.ok || !second.ok) throw new Error('not created')
  expect(first.matchId).not.toBe(second.matchId)
  expect(matches.getState().matches).toEqual({
    status: 'ready',
    matches: [
      { matchId: second.matchId, opponentName: 'Bo', bestOf: 3, rated: false },
      { matchId: first.matchId, opponentName: 'Ana', bestOf: 5, rated: true },
    ],
  })
})

test('a match created with no opponent’s name is listed with opponentName null', async () => {
  const { matches } = fresh()

  const created = await matches
    .getState()
    .createMatch({ opponentName: null, format: { bestOf: 3 }, rated: false })
  await matches.getState().load()

  if (!created.ok) throw new Error('not created')
  expect(matches.getState().matches).toEqual({
    status: 'ready',
    matches: [{ matchId: created.matchId, opponentName: null, bestOf: 3, rated: false }],
  })
})

test('the list is unread until its first load', () => {
  const { matches } = fresh()

  expect(matches.getState().matches).toEqual({ status: 'unread' })
})

test('a watched list is read again after another store writes a match', async () => {
  const memory = createMatchMemory()
  const watched = createMatchesStore(memory)
  const other = createMatchesStore(memory)
  await watched.getState().load()
  watched.getState().watchMatches()

  const created = await other.getState().createMatch(againstAna)

  if (!created.ok) throw new Error('not created')
  await vi.waitFor(() =>
    expect(watched.getState().matches).toEqual({
      status: 'ready',
      matches: [{ matchId: created.matchId, opponentName: 'Ana', bestOf: 5, rated: true }],
    }),
  )
})

test('a list nobody watches goes back to unread after another store writes a match', async () => {
  const memory = createMatchMemory()
  const unwatched = createMatchesStore(memory)
  const other = createMatchesStore(memory)
  await unwatched.getState().load()
  const stop = unwatched.getState().watchMatches()
  stop()

  await other.getState().createMatch(againstAna)

  expect(unwatched.getState().matches).toEqual({ status: 'unread' })
})
