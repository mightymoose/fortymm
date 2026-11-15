import { createStore, useStore } from 'zustand'
import { matchMemory } from './match-memory.ts'
import type {
  Failure,
  MatchSource,
  MatchSummary,
  MatchToCreate,
  Unavailable,
} from './match-source.ts'
import { createQueue } from './queue.ts'

// Kept in match-source.ts, which the sources read too; given again here for
// this store's callers.
export type { MatchSummary, MatchToCreate } from './match-source.ts'

// This device's matches as a list, for the page that shows them, and
// creating a match. The interface is the plan's `my-matches.ts`
// (PLAN-match-store-and-sync.md §2), named without "my", and without the
// revision only the device's storage keeps. It reads and writes through a
// source (match-source.ts), the same one the match store reads: until
// IndexedDB and the journal exist (tasks D to G2) the app's is a memory
// (match-memory.ts), so a reload loses them.
//
// A create goes to the source first. The list changes only by being read
// again, after the write succeeded; a create the source refuses is returned
// and leaves the list as it was.
//
// As in the plan, after a write to any match the list is read again if a
// mounted page watches it (watchMatches), and goes back to unread if not.

// - unread: not read since the last change (or ever).
// - ready: every match, newest first.
// - unavailable: the source refused the read.
export type MatchesState =
  | { status: 'unread' }
  | { status: 'ready'; matches: MatchSummary[] }
  | { status: 'unavailable'; reason: Unavailable['reason'] }

export type CreateMatchResult = { ok: true; matchId: string } | ({ ok: false } & Failure)

export type MatchesStore = {
  matches: MatchesState
  // For loaders: resolves once the list has been read. Never rejects.
  load(): Promise<void>
  // While a page shows the list: keeps it current after every write. Gives
  // the function that stops watching.
  watchMatches(): () => void
  // Keeps a new match with no games, under a fresh id, and gives the id.
  createMatch(match: MatchToCreate): Promise<CreateMatchResult>
}

// A store of its own over `source`. The app has one, matchesStore, over the
// app's memory; a test builds a fresh one over a fresh memory.
export function createMatchesStore(source: MatchSource = matchMemory) {
  const queue = createQueue()
  let watchers = 0

  const read = async () => {
    const listed = await source.list()
    store.setState({
      matches: listed.ok
        ? { status: 'ready', matches: listed.matches }
        : { status: 'unavailable', reason: listed.reason },
    })
  }

  const store = createStore<MatchesStore>()(() => ({
    matches: { status: 'unread' },
    load: () => queue(read),
    watchMatches() {
      watchers += 1
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        watchers -= 1
      }
    },
    createMatch: (match) =>
      queue(async () => {
        const created = await source.create(match)
        if (created.ok) await read()
        return created
      }),
  }))

  // After a write to any match, and when any match may have changed ('all').
  source.onChange(() => {
    if (watchers > 0) void queue(read)
    else store.setState({ matches: { status: 'unread' } })
  })
  return store
}

export const matchesStore = createMatchesStore()

// The list, for a connected component.
export function useMatches(): MatchesState {
  return useStore(matchesStore, (store) => store.matches)
}
