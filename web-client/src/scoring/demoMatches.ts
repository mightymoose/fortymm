import { notFound } from '@tanstack/react-router'
import type { BestOf, Side } from './board'

// The matches the scoring page can open until the API has matches.

export type MatchPlayer = { id: string; name: string }

export type Match = {
  id: string
  bestOf: BestOf
  // Their order fixes the order of each game's points.
  players: [MatchPlayer, MatchPlayer]
}

// Who is looking at the match. Only a player can submit its result.
export type Viewer = { role: 'player'; side: Side } | { role: 'spectator' }

const OPPONENT: MatchPlayer = { id: '6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13', name: 'brave badger 214' }
const SPECTATED: [MatchPlayer, MatchPlayer] = [
  { id: '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40', name: 'calm crane 552' },
  { id: 'a4d8f0e6-1b2c-4e3d-8f5a-9c7b6e1d2f08', name: 'gentle gecko 731' },
]

// The match `id` names, with `self` as the viewer's player. Throws
// notFound() for any other id.
export function demoMatch(id: string, self: MatchPlayer): Match {
  switch (id) {
    case 'demo':
      return { id, bestOf: 5, players: [self, OPPONENT] }
    case 'demo-spectator':
      return { id, bestOf: 5, players: SPECTATED }
    default:
      throw notFound()
  }
}

export function viewerOf(match: Match, playerId: string): Viewer {
  const side = match.players.findIndex((player) => player.id === playerId)
  return side === 0 || side === 1 ? { role: 'player', side } : { role: 'spectator' }
}
