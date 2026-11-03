import { notFound } from '@tanstack/react-router'
import type { BestOf, Side } from './board'

// The matches the scoring page can open until the API has matches.

export type MatchPlayer = { id: string; name: string }

export type Match = {
  // In the URL.
  id: string
  // The id a signed result names.
  uuid: string
  bestOf: BestOf
  rated: boolean
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
      return {
        id,
        uuid: '3b7e9f2a-6c41-4d8e-b5a0-1f9c2d7e4a63',
        bestOf: 5,
        rated: false,
        players: [self, OPPONENT],
      }
    case 'demo-spectator':
      return {
        id,
        uuid: 'd5a1c8e4-2f7b-4b93-8e06-7c4f1a9b3e25',
        bestOf: 5,
        rated: false,
        players: SPECTATED,
      }
    default:
      throw notFound()
  }
}

export function viewerOf(match: Match, playerId: string): Viewer {
  const side = match.players.findIndex((player) => player.id === playerId)
  return side === 0 || side === 1 ? { role: 'player', side } : { role: 'spectator' }
}
