import type { BestOf, Score } from '../scoring/scoring.ts'

// This tab's matches, in memory: what the match stores (match.ts,
// my-matches.ts) read and write until the plan's IndexedDB storage and
// journal exist (tasks D to G). It stands where storage.ts and its
// announcement will: the one source of truth both stores read, and the one
// place that says a match changed, after each write. Nothing is kept past the
// page: a reload loses every match (the user's decision), and nothing is
// written to IndexedDB, localStorage or sessionStorage.
//
// It knows no rules: the stores ask the scoring rules before they write.

export type StoredMatch = {
  readonly matchId: string
  readonly opponentName: string
  readonly bestOf: BestOf
  readonly rated: boolean
  // The saved games in game order: games[0] is game 1.
  readonly games: readonly Score[]
}

export type MatchMemory = {
  // Keeps a new match, as the newest.
  add(match: StoredMatch): void
  // The match, or null for an id nobody added.
  read(matchId: string): StoredMatch | null
  // Replaces a kept match's games. An id nobody added is ignored.
  setGames(matchId: string, games: readonly Score[]): void
  // Every match, newest first.
  list(): StoredMatch[]
  // Calls listener with the id of each match a write changed, after the
  // write. Gives the function that stops it.
  onChange(listener: (matchId: string) => void): () => void
}

// A memory of its own. The app has one, matchMemory; a test builds a fresh
// one and hands it to the stores it builds.
export function createMatchMemory(): MatchMemory {
  // A Map keeps insertion order: oldest first.
  const matches = new Map<string, StoredMatch>()
  const listeners = new Set<(matchId: string) => void>()

  const changed = (matchId: string) => {
    for (const listener of [...listeners]) listener(matchId)
  }

  return {
    add(match) {
      matches.set(match.matchId, match)
      changed(match.matchId)
    },
    read: (matchId) => matches.get(matchId) ?? null,
    setGames(matchId, games) {
      const match = matches.get(matchId)
      if (match === undefined) return
      matches.set(matchId, { ...match, games: [...games] })
      changed(matchId)
    },
    list: () => [...matches.values()].reverse(),
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const matchMemory = createMatchMemory()
