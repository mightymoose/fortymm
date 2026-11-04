import type { Failure } from '../../../api/errors'
import type { MatchRequest } from '../../../api/queries'
import type { BestOf } from '../../../scoring/board'

export type Opponent = { id: string; name: string }

// A match needs two players, so there is no match without an opponent.
export type OpponentChoice = { kind: 'none' } | { kind: 'picked'; opponent: Opponent }

export type Submit =
  | { kind: 'idle' }
  | { kind: 'needsOpponent' }
  | { kind: 'starting' }
  | { kind: 'refused'; title: string }
  | { kind: 'failed'; failure: Failure }
  // No connection: making a match needs one.
  | { kind: 'offline' }

// The new match form. `attempt` is the last press of Start match: a press
// with the same details sends the same id, so a retry after a lost
// response finds the match the first press made.
export type Setup = {
  opponent: OpponentChoice
  bestOf: BestOf
  rated: boolean
  attempt: MatchRequest | null
  submit: Submit
}

export type SetupAction =
  | { type: 'pick'; opponent: Opponent }
  | { type: 'clearOpponent' }
  | { type: 'bestOf'; bestOf: BestOf }
  | { type: 'rated'; rated: boolean }
  | { type: 'start'; self: string; freshId: string }
  | { type: 'refused'; title: string }
  | { type: 'failed'; failure: Failure }
  | { type: 'offline' }

export const initialSetup: Setup = {
  opponent: { kind: 'none' },
  bestOf: 5,
  rated: false,
  attempt: null,
  submit: { kind: 'idle' },
}

export function setupReducer(setup: Setup, action: SetupAction): Setup {
  switch (action.type) {
    case 'pick':
      return { ...setup, opponent: { kind: 'picked', opponent: action.opponent }, submit: { kind: 'idle' } }
    case 'clearOpponent':
      // Rated needs an opponent, so a new opponent starts unrated.
      return { ...setup, opponent: { kind: 'none' }, rated: false }
    case 'bestOf':
      return { ...setup, bestOf: action.bestOf }
    case 'rated':
      return setup.opponent.kind === 'picked' ? { ...setup, rated: action.rated } : setup
    case 'start': {
      if (setup.submit.kind === 'starting') return setup
      if (setup.opponent.kind === 'none') return { ...setup, submit: { kind: 'needsOpponent' } }
      const details = {
        best_of: setup.bestOf,
        rated: setup.rated,
        players: [action.self, setup.opponent.opponent.id],
      }
      const id = setup.attempt && sameDetails(setup.attempt, details) ? setup.attempt.id : action.freshId
      return { ...setup, attempt: { id, ...details }, submit: { kind: 'starting' } }
    }
    case 'refused':
      return { ...setup, submit: { kind: 'refused', title: action.title } }
    case 'failed':
      return { ...setup, submit: { kind: 'failed', failure: action.failure } }
    case 'offline':
      return { ...setup, submit: { kind: 'offline' } }
  }
}

function sameDetails(a: Omit<MatchRequest, 'id'>, b: Omit<MatchRequest, 'id'>): boolean {
  return a.best_of === b.best_of && a.rated === b.rated && a.players.join() === b.players.join()
}

export const BEST_OF_OPTIONS: readonly { bestOf: BestOf; label: string }[] = [
  { bestOf: 1, label: 'Single' },
  { bestOf: 3, label: 'Short' },
  { bestOf: 5, label: 'Std' },
  { bestOf: 7, label: 'Long' },
]

export function lengthHelp(bestOf: BestOf): string {
  return bestOf === 1 ? 'One game, winner takes all.' : `First to ${winsNeeded(bestOf)} games.`
}

// The line under the summary's headline, such as "Best of 5 · first to 3 ·
// Unrated · games to 11, win by 2".
export function summaryLine(setup: Setup): string {
  const length = setup.bestOf === 1 ? 'Single game' : `Best of ${setup.bestOf} · first to ${winsNeeded(setup.bestOf)}`
  return `${length} · ${setup.rated ? 'Rated' : 'Unrated'} · games to 11, win by 2`
}

function winsNeeded(bestOf: BestOf): number {
  return Math.ceil(bestOf / 2)
}
