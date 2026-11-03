import { otherSide, type GamePoints, type Side } from '../../scoring/board'
import type { Match, Viewer } from '../../scoring/demoMatches'

export const ROUTE = '/_authenticated/matches/$matchId/scores/game/$gameNumber/edit'
export const PATH = '/matches/$matchId/scores/game/$gameNumber/edit'

// The two sides as the page shows them, left then right: the viewer's side
// first when they play. The points stay stored in the match's order.
export type Sides = [Side, Side]

export function sidesFor(left: Side): Sides {
  return [left, otherSide(left)]
}

// A score as the page shows it, left side first.
export function shown(points: GamePoints, sides: Sides): string {
  return `${points[sides[0]]}–${points[sides[1]]}`
}

// The games each side won, the winner's first, such as "3–1".
export function gamesWon(won: [number, number], winner: Side): string {
  return `${won[winner]}–${won[otherSide(winner)]}`
}

// How the scoring page names a player: You and Your opponent to a player,
// and the player's name to a spectator. `fallback` names an id that isn't
// one of the match's players, such as a spectator who saved a game.
export function playerLabel(match: Match, viewer: Viewer, playerId: string, fallback = 'a spectator'): string {
  if (viewer.role === 'player') {
    if (match.players[viewer.side].id === playerId) return 'You'
    if (match.players[otherSide(viewer.side)].id === playerId) return 'Your opponent'
  }
  return match.players.find((player) => player.id === playerId)?.name ?? fallback
}

// A label inside a sentence, such as "Saved by you".
export function midSentence(label: string): string {
  return label === 'You' || label === 'Your opponent' ? label.toLowerCase() : label
}

// "You win 3–1", or "<label> wins 3–1".
export function wins(label: string, score: string): string {
  return `${label} ${label === 'You' ? 'win' : 'wins'} ${score}`
}
