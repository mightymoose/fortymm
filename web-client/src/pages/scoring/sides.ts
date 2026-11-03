import { otherSide, type GamePoints, type Side } from '../../scoring/board'

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
