import { createStore, useStore } from 'zustand'
import { mayClear, saveRefusal, type BestOf, type Games, type Score } from '../scoring/scoring.ts'
import { matchMemory } from './match-memory.ts'
import type { ActionResult, MatchSource, StoredMatch, Unavailable } from './match-source.ts'
import { createQueue } from './queue.ts'

export type { ActionResult, Failure, Refusal } from './match-source.ts'

// One entry per match id, for the pages that open a match (the scoring screen
// first), and the scoring actions. The interface is the plan's match store
// (PLAN-match-store-and-sync.md §2). It reads and writes through a source
// (match-source.ts) and knows nothing about where matches are kept: until
// IndexedDB and the journal exist (tasks D to G2) the app's source is a
// memory (match-memory.ts), so a reload loses them.
//
// A write goes to the source first. Only when it has succeeded does the
// store change, by reading the match again; a write the source refuses is
// returned and leaves the store as it was. There is no optimistic update.
//
// Only watched matches reload, as in the plan: after a write to a match, an
// entry a mounted page watches (watchMatch) is read again, so the page shows
// it; an entry nobody watches is dropped, and the next page that opens it
// reads it fresh through its loader (load).

// What a screen shows of a match.
export type MatchState = {
  // null: no opponent's name was given (a screen names it with
  // components/opponent.ts).
  opponentName: string | null
  bestOf: BestOf
  rated: boolean
  // The games, one slot per game number: games[0] is game 1 (scoring.ts).
  games: Games
}

// A match as this store holds it.
// - ready: the match.
// - missing: no match of that id on this device (in memory: nobody created
//   it in this page's life; a reload loses every match).
// - unavailable: the source refused the read.
export type MatchEntry =
  | { status: 'ready'; match: MatchState }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: Unavailable['reason'] }

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
  // Clears game `game`, any saved game, leaving its slot empty (a gap when
  // a later game is saved), unless it isn't saved (mayClear).
  clearGameScore(matchId: string, game: number): Promise<ActionResult>
}

// A store of its own over `source`. The app has one, matchStore, over the
// app's memory; a test builds a fresh one over a fresh memory.
export function createMatchStore(source: MatchSource = matchMemory) {
  const queue = createQueue()
  // How many mounted pages watch each match.
  const watching = new Map<string, number>()

  // Reads the match and replaces its entry, in one set.
  const read = async (matchId: string): Promise<MatchEntry> => {
    const entry = entryOf(await source.read(matchId))
    store.setState((state) => ({ matches: { ...state.matches, [matchId]: entry } }))
    return entry
  }

  // Has the source save what `decide` says game `game` becomes, then reads
  // the match again; or answers why not, changing nothing.
  const save = (
    matchId: string,
    game: number,
    decide: Parameters<MatchSource['saveGame']>[2],
  ): Promise<ActionResult> =>
    queue(async () => {
      const saved = await source.saveGame(matchId, game, decide)
      if (saved.ok) await read(matchId)
      return saved
    })

  const store = createStore<MatchStore>()(() => ({
    matches: {},
    load: (matchId) => queue(() => read(matchId)),
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
    // The source asks these rules, about the match as it keeps it at that
    // moment, never about this store's copy.
    setGameScore: (matchId, game, score) =>
      save(matchId, game, ({ games, bestOf }) => {
        const refusal = saveRefusal(games, bestOf, game, score)
        if (refusal !== null) return refusal
        return { score: [score[0], score[1]] }
      }),
    clearGameScore: (matchId, game) =>
      save(matchId, game, ({ games }) => {
        if (!mayClear(games, game))
          return { reason: 'not-clearable', message: `Game ${game} isn’t saved.` }
        return { score: null }
      }),
  }))

  // After a write: each changed match a page watches is read again, and the
  // others are dropped. 'all' is every match this store holds or watches.
  source.onChange((changed) => {
    const ids =
      changed === 'all'
        ? [...new Set([...Object.keys(store.getState().matches), ...watching.keys()])]
        : changed
    for (const matchId of ids) {
      if (watching.has(matchId)) void queue(() => read(matchId))
    }
    const dropped = ids.filter((matchId) => !watching.has(matchId))
    store.setState((state) => {
      if (!dropped.some((matchId) => matchId in state.matches)) return state
      const matches = { ...state.matches }
      for (const matchId of dropped) delete matches[matchId]
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

function entryOf(read: { ok: true; match: StoredMatch | null } | Unavailable): MatchEntry {
  if (!read.ok) return { status: 'unavailable', reason: read.reason }
  if (read.match === null) return { status: 'missing' }
  const { opponentName, bestOf, rated, games } = read.match
  return { status: 'ready', match: { opponentName, bestOf, rated, games } }
}
