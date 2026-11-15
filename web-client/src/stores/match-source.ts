import type { BestOf, Games, SaveRefusal, Score } from '../scoring/scoring.ts'

// Where matches are kept: the type both match stores (match.ts, matches.ts)
// read and write through (PLAN-match-store-and-sync.md §2). The stores know
// nothing else about it. Today the app's source is a memory
// (match-memory.ts); the device's storage and journal will be another
// (task G2), with no change to the stores.
//
// Every call is a promise that never rejects: a read or a write the device
// refuses is a typed answer. A source knows no rules: a save hands it
// `decide`, and it asks `decide` about the match as it holds it at that
// moment, where no other write can come between the answer and the write.

// A match as a source keeps it.
export type StoredMatch = {
  readonly matchId: string
  // The name typed for the opponent, or null for a match recorded with none
  // (never an empty string).
  readonly opponentName: string | null
  readonly bestOf: BestOf
  readonly rated: boolean
  // The games, one slot per game number: games[0] is game 1 (scoring.ts).
  readonly games: Games
}

// A match as the list shows it.
export type MatchSummary = {
  matchId: string
  // null: no opponent's name was given.
  opponentName: string | null
  bestOf: BestOf
  rated: boolean
}

// A match to create: the opponent's name (null for none), its format, as
// the plan's match descriptor names it, and whether it is rated. The stores'
// own type, not the form's: the new match form's output (NewMatch) fits it,
// and other callers may create a match with no name. Neither a store nor a
// source checks it: rated needing a name is the form's rule.
export type MatchToCreate = {
  opponentName: string | null
  format: { bestOf: BestOf }
  rated: boolean
}

// A write the device refused: nothing was kept.
export type Failure = {
  reason: 'storage-unavailable' | 'locks-unavailable' | 'signing-unavailable' | 'core-unavailable'
}

// A read the device refused.
export type Unavailable = { ok: false; reason: 'storage-unavailable' | 'core-unavailable' }

// A score the rules refuse, or a game that may not be cleared, or a match
// that isn't on this device: nothing changed, and the message says why.
export type Refusal = {
  reason: SaveRefusal['reason'] | 'not-clearable' | 'missing'
  message: string
}

export type ActionResult = { ok: true } | ({ ok: false } & (Failure | Refusal))

// What a source answers a save of a match it doesn't keep.
export const missingMatch: Refusal = {
  reason: 'missing',
  message: 'This match isn’t on this device.',
}

export type MatchSource = {
  // Keeps a new match with no games, as the newest, under a fresh id, and
  // gives the id.
  create(match: MatchToCreate): Promise<{ ok: true; matchId: string } | ({ ok: false } & Failure)>
  // Asks `decide` what game `game` (1 is the first) becomes, on the match as
  // kept at that moment, and saves it: a score, or null for an empty slot.
  // What `decide` refuses is answered as it gave it, and nothing is written.
  // A match that isn't kept is `missingMatch`, and `decide` isn't asked.
  saveGame(
    matchId: string,
    game: number,
    decide: (match: StoredMatch) => Refusal | { score: Score | null },
  ): Promise<ActionResult>
  // The match, or null for an id that isn't kept.
  read(matchId: string): Promise<{ ok: true; match: StoredMatch | null } | Unavailable>
  // Every match, newest first.
  list(): Promise<{ ok: true; matches: MatchSummary[] } | Unavailable>
  // Calls listener after each write, with the ids of the matches it changed,
  // or 'all' when any match may have changed. Gives the function that stops
  // it.
  onChange(listener: (matches: string[] | 'all') => void): () => void
}
