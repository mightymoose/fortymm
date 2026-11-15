import { createStore, useStore } from 'zustand'
import type { NewMatch } from '../components/new-match/NewMatchScreen.schema.ts'
import type { BestOf } from '../scoring/scoring.ts'
import type { Failure } from './match.ts'
import { matchMemory, type MatchMemory } from './match-memory.ts'
import { createQueue } from './queue.ts'

// This device's matches as a list, for the page that will show them, and
// creating a match. The interface is the plan's (PLAN-match-store-and-sync.md
// §2), without the revision only the device's storage keeps; until IndexedDB
// and the journal exist (tasks D to G) its matches are in memory
// (match-memory.ts), the same memory the match store reads, so a reload loses
// them.
//
// As in the plan, after a write to any match the list is read again if a
// mounted page watches it (watchMyMatches), and goes back to unread if not.

// A match as the list shows it.
export type MatchSummary = {
  matchId: string
  opponentName: string
  bestOf: BestOf
  rated: boolean
}

// - unread: not read since the last change (or ever).
// - ready: every match, newest first.
// - unavailable: the device's storage refused. Only the real store gives it.
export type MyMatchesState =
  | { status: 'unread' }
  | { status: 'ready'; matches: MatchSummary[] }
  | { status: 'unavailable'; reason: 'storage-unavailable' | 'core-unavailable' }

export type CreateMatchResult = { ok: true; matchId: string } | ({ ok: false } & Failure)

export type MyMatchesStore = {
  myMatches: MyMatchesState
  // For loaders: resolves once the list has been read. Never rejects.
  load(): Promise<void>
  // While a page shows the list: keeps it current after every write. Gives
  // the function that stops watching.
  watchMyMatches(): () => void
  // Keeps a new match with no games, under a fresh id, and gives the id.
  createMatch(match: NewMatch): Promise<CreateMatchResult>
}

// A store of its own over `memory`. The app has one, myMatchesStore, over the
// app's memory; a test builds a fresh one over a fresh memory.
export function createMyMatchesStore(memory: MatchMemory = matchMemory) {
  const queue = createQueue()
  let watchers = 0

  const read = () => {
    const matches = memory.list().map(({ matchId, opponentName, bestOf, rated }) => ({
      matchId,
      opponentName,
      bestOf,
      rated,
    }))
    store.setState({ myMatches: { status: 'ready', matches } })
  }

  const store = createStore<MyMatchesStore>()(() => ({
    myMatches: { status: 'unread' },
    load: () => queue(async () => read()),
    watchMyMatches() {
      watchers += 1
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        watchers -= 1
      }
    },
    createMatch: ({ opponentName, format, rated }) =>
      queue(async () => {
        const matchId = crypto.randomUUID()
        memory.add({ matchId, opponentName, bestOf: format.bestOf, rated, games: [] })
        read()
        return { ok: true, matchId }
      }),
  }))

  memory.onChange(() => {
    if (watchers > 0) void queue(async () => read())
    else store.setState({ myMatches: { status: 'unread' } })
  })
  return store
}

export const myMatchesStore = createMyMatchesStore()

// The list, for a connected component.
export function useMyMatches(): MyMatchesState {
  return useStore(myMatchesStore, (store) => store.myMatches)
}
