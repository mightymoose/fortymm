import { createStore, useStore } from 'zustand'
import {
  mayClear,
  saveRefusal,
  type BestOf,
  type SaveRefusal,
  type Score,
} from '../scoring/scoring.ts'
import { matchMemory, type MatchMemory, type StoredMatch } from './match-memory.ts'
import { createQueue } from './queue.ts'

// One entry per match id, for the pages that open a match (the scoring screen
// first), and the scoring actions. The interface is the plan's match store
// (PLAN-match-store-and-sync.md §2); until IndexedDB and the journal exist
// (tasks D to G) its matches are in memory (match-memory.ts), so a reload
// loses them, and those tasks replace only this module's insides.
//
// Only watched matches reload, as in the plan: after a write to a match, an
// entry a mounted page watches (watchMatch) is read again, so the page shows
// it; an entry nobody watches is dropped, and the next page that opens it
// reads it fresh through its loader (load).

// What a screen shows of a match.
export type MatchState = {
  opponentName: string
  bestOf: BestOf
  rated: boolean
  // The saved games in game order: games[0] is game 1.
  games: readonly Score[]
}

// A match as this store holds it.
// - ready: the match.
// - missing: no match of that id on this device (in memory: nobody created
//   it in this page's life; a reload loses every match).
// - unavailable: the device's storage refused. Only the real store gives it;
//   memory never does, but callers handle it already.
export type MatchEntry =
  | { status: 'ready'; match: MatchState }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: 'storage-unavailable' | 'core-unavailable' }

// A write the device refused. Only the real store gives one; memory never does.
export type Failure = {
  reason: 'storage-unavailable' | 'locks-unavailable' | 'signing-unavailable' | 'core-unavailable'
}

// A score the rules refuse, or a game that may not be cleared, or a match
// that isn't on this device: nothing changed, and the message says why.
export type Refusal = {
  reason: SaveRefusal['reason'] | 'not-clearable' | 'missing'
  message: string
}

export type ActionResult = { ok: true } | ({ ok: false } & (Failure | Refusal))

export type MatchStore = {
  matches: Record<string, MatchEntry>
  // For loaders: reads the match, puts it in the store and gives its entry
  // (missing for an id nobody created). Never rejects.
  load(matchId: string): Promise<MatchEntry>
  // While a page shows the match: keeps its entry current after every write
  // to it. Gives the function that stops watching.
  watchMatch(matchId: string): () => void
  // Saves `score` as game `game` (1 is the first), a new game or a
  // correction, unless the scoring rules refuse it (saveRefusal).
  setGameScore(matchId: string, game: number, score: Score): Promise<ActionResult>
  // Clears game `game`, unless it isn't the highest saved game (mayClear).
  clearGameScore(matchId: string, game: number): Promise<ActionResult>
}

// A store of its own over `memory`. The app has one, matchStore, over the
// app's memory; a test builds a fresh one over a fresh memory.
export function createMatchStore(memory: MatchMemory = matchMemory) {
  const queue = createQueue()
  // How many mounted pages watch each match.
  const watching = new Map<string, number>()

  // Reads the match and replaces its entry, in one set.
  const read = (matchId: string): MatchEntry => {
    const entry = entryOf(memory.read(matchId))
    store.setState((state) => ({ matches: { ...state.matches, [matchId]: entry } }))
    return entry
  }

  // Asks `decide` what to write to the match's games, writes it, and reads
  // the match again; or answers why not, changing nothing.
  const write = (
    matchId: string,
    decide: (match: StoredMatch) => Refusal | { games: Score[] },
  ): Promise<ActionResult> =>
    queue(async () => {
      const match = memory.read(matchId)
      if (match === null)
        return { ok: false, reason: 'missing', message: 'This match isn’t on this device.' }
      const decided = decide(match)
      if ('reason' in decided) return { ok: false, ...decided }
      memory.setGames(matchId, decided.games)
      read(matchId)
      return { ok: true }
    })

  const store = createStore<MatchStore>()(() => ({
    matches: {},
    load: (matchId) => queue(async () => read(matchId)),
    watchMatch(matchId) {
      watching.set(matchId, (watching.get(matchId) ?? 0) + 1)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        const left = (watching.get(matchId) ?? 1) - 1
        if (left === 0) watching.delete(matchId)
        else watching.set(matchId, left)
      }
    },
    setGameScore: (matchId, game, score) =>
      write(matchId, ({ games, bestOf }) => {
        const refusal = saveRefusal(games, bestOf, game, score)
        if (refusal !== null) return refusal
        const saved: Score = [score[0], score[1]]
        return { games: game > games.length ? [...games, saved] : games.with(game - 1, saved) }
      }),
    clearGameScore: (matchId, game) =>
      write(matchId, ({ games }) => {
        if (!mayClear(games, game))
          return {
            reason: 'not-clearable',
            message:
              games.length === 0
                ? 'No game is saved yet.'
                : `Only the last saved game, game ${games.length}, can be cleared.`,
          }
        return { games: games.slice(0, -1) }
      }),
  }))

  memory.onChange((matchId) => {
    if (watching.has(matchId)) {
      void queue(async () => {
        read(matchId)
      })
      return
    }
    store.setState((state) => {
      if (!(matchId in state.matches)) return state
      const matches = { ...state.matches }
      delete matches[matchId]
      return { matches }
    })
  })
  return store
}

export const matchStore = createMatchStore()

// The match's entry, for a connected component; undefined before its load.
export function useMatch(matchId: string): MatchEntry | undefined {
  return useStore(matchStore, (store) => store.matches[matchId])
}

function entryOf(match: StoredMatch | null): MatchEntry {
  if (match === null) return { status: 'missing' }
  const { opponentName, bestOf, rated, games } = match
  return { status: 'ready', match: { opponentName, bestOf, rated, games } }
}
