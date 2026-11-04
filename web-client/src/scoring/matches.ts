import { notFound } from '@tanstack/react-router'
import type { MatchResult } from '../signing/result'
import type { BestOf } from './board'
import { demoMatch, matchFor, type Match, type MatchPlayer } from './demoMatches'
import { fragmentResult } from './fragment'

// The match a scoring page opens. A demo match is the session's own, so a
// page works it out from the session on each render: a saved account can
// stand in for the session until the API answers with another player. A
// match the API made is the same for everyone.
type ScoringMatch = { kind: 'demo'; id: string } | { kind: 'api'; match: Match }

const DEMO_IDS = new Set(['demo', 'demo-spectator'])

// For a scoring route's loader, with the URL's fragment. An API match's
// fragment holds its details, so the loader reads them from it and sends
// no request, which works with no network. A fragment that is empty,
// can't be read or names another match throws notFound().
export function scoringMatch(matchId: string, hash: string): ScoringMatch {
  if (DEMO_IDS.has(matchId)) return { kind: 'demo', id: matchId }
  const carried = fragmentResult(hash)
  if (carried?.match !== matchId) throw notFound()
  return { kind: 'api', match: apiMatch(matchId, carried.bestOf, carried.rated, carried.players) }
}

// The match on screen. A demo match names the players of `result`, the
// fragment's, as matchFor() works them out.
export function matchOf(scoring: ScoringMatch, self: MatchPlayer, result: MatchResult | null): Match {
  if (scoring.kind === 'api') return scoring.match
  return matchFor(scoring.id, self, result) ?? demoMatch(scoring.id, self)
}

// A match the API made. Nothing on the device knows its players' names, so
// a spectator sees Player 1 and Player 2, and a player sees You and Your
// opponent.
export function apiMatch(id: string, bestOf: BestOf, rated: boolean, players: readonly [string, string]): Match {
  return {
    source: 'api',
    id,
    uuid: id,
    bestOf,
    rated,
    players: [
      { id: players[0], name: 'Player 1' },
      { id: players[1], name: 'Player 2' },
    ],
  }
}
