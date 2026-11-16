import { withGame } from '../scoring/scoring.ts'
import {
  missingMatch,
  type Failure,
  type MatchSource,
  type StoredMatch,
  type Unavailable,
} from './match-source.ts'

// This tab's matches, in memory: the source (match-source.ts) the match
// stores read and write until the plan's IndexedDB storage and journal exist
// (tasks D to G2). It stands where they will: the one source of truth both
// stores read, and the one place that says a match changed, after each
// write. Nothing is kept past the page: a reload loses every match (the
// user's decision), and nothing is written to IndexedDB, localStorage or
// sessionStorage.
//
// It knows no rules: a save runs the `decide` it is handed, on the match as
// kept when the write happens.
//
// Left alone it never fails and never waits longer than a promise takes. For
// tests it can be told to hold or fail its next read or write, as the
// device's storage can.

export type MatchMemory = MatchSource & {
  // For tests. Each acts on the next call of its kind only: a read is `read`
  // or `list`, a write is `create` or `saveGame`.
  //
  // Holds the next read open: it takes what is kept when it is called, and
  // answers with that once the function this gives is called.
  holdNextRead(): () => void
  // Holds the next write open: it writes nothing, and asks no `decide`,
  // until the function this gives is called.
  holdNextWrite(): () => void
  // Makes the next read answer that the device refused.
  failNextRead(reason: Unavailable['reason']): void
  // Makes the next write keep nothing and answer that the device refused.
  failNextWrite(reason: Failure['reason']): void
  // Says any match may have changed, as the device does when a page is shown
  // again.
  announceAll(): void
}

// What the next call of one kind does first: wait, fail, or neither.
type Next<Reason> = { held: Promise<void> | null; failure: Reason | null }

// A memory of its own. The app has one, matchMemory; a test builds a fresh
// one and hands it to the stores it builds.
export function createMatchMemory(): MatchMemory {
  // A Map keeps insertion order: oldest first.
  const matches = new Map<string, StoredMatch>()
  const listeners = new Set<(matches: string[] | 'all') => void>()
  const nextRead: Next<Unavailable['reason']> = { held: null, failure: null }
  const nextWrite: Next<Failure['reason']> = { held: null, failure: null }

  const changed = (changes: string[] | 'all') => {
    for (const listener of [...listeners]) listener(changes)
  }

  // Takes what the next call was told to do, waits if it is held, and gives
  // the failure it was told to answer, or null.
  const begin = async <Reason>(next: Next<Reason>): Promise<Reason | null> => {
    const { held, failure } = next
    next.held = null
    next.failure = null
    if (held !== null) await held
    return failure
  }

  const hold = (next: Next<unknown>) => {
    let release = () => {}
    next.held = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  return {
    async create({ format, rated }) {
      const failure = await begin(nextWrite)
      if (failure !== null) return { ok: false, reason: failure }
      const matchId = crypto.randomUUID()
      matches.set(matchId, { matchId, bestOf: format.bestOf, rated, games: [] })
      changed([matchId])
      return { ok: true, matchId }
    },
    async saveGame(matchId, game, decide) {
      const failure = await begin(nextWrite)
      if (failure !== null) return { ok: false, reason: failure }
      const match = matches.get(matchId)
      if (match === undefined) return { ok: false, ...missingMatch }
      const decided = decide(match)
      if ('reason' in decided) return { ok: false, ...decided }
      matches.set(matchId, { ...match, games: withGame(match.games, game, decided.score) })
      changed([matchId])
      return { ok: true }
    },
    async read(matchId) {
      // Taken before any wait: a read held open answers with the match as
      // it was when the read began.
      const match = matches.get(matchId) ?? null
      const failure = await begin(nextRead)
      if (failure !== null) return { ok: false, reason: failure }
      return { ok: true, match }
    },
    async list() {
      const kept = [...matches.values()].reverse()
      const failure = await begin(nextRead)
      if (failure !== null) return { ok: false, reason: failure }
      return {
        ok: true,
        matches: kept.map(({ matchId, bestOf, rated }) => ({
          matchId,
          bestOf,
          rated,
        })),
      }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    holdNextRead: () => hold(nextRead),
    holdNextWrite: () => hold(nextWrite),
    failNextRead(reason) {
      nextRead.failure = reason
    },
    failNextWrite(reason) {
      nextWrite.failure = reason
    },
    announceAll: () => changed('all'),
  }
}

export const matchMemory = createMatchMemory()
