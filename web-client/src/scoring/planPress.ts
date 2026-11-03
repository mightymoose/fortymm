import { reviewBoard, type BestOf, type GamePoints, type ScoreEntry, type Side } from './board'
import type { Viewer } from './demoMatches'

// What the pad's button does when pressed.
export type Press =
  | { kind: 'disabled' }
  // `next` is the game to open after saving, or null to stay.
  | { kind: 'save'; points: GamePoints; next: number | null }
  // Submits `games`, which hold the typed score of the game on screen.
  | { kind: 'submit'; games: GamePoints[]; winner: Side }

// A player whose press would leave a decided board submits it. Anyone else,
// or a board that isn't decided, saves a legal score. `games` are the
// entered games in order, and `gameNumber` is at most one past the last.
export function planPress(
  games: readonly GamePoints[],
  viewer: Viewer,
  gameNumber: number,
  entry: ScoreEntry,
  bestOf: BestOf,
): Press {
  const slots = slotsOf(games, bestOf)
  if (entry.kind === 'legal') slots[gameNumber - 1] = entry.points
  const review = reviewBoard(slots, bestOf)
  if (viewer.role === 'player' && review.kind === 'decided' && (entry.kind === 'legal' || entry.kind === 'empty')) {
    return { kind: 'submit', games: review.games, winner: review.winner }
  }
  if (entry.kind !== 'legal') return { kind: 'disabled' }
  // Once the match is decided, the next empty game would only be an extra one.
  const next = review.kind === 'undecided' ? slots.findIndex((slot, index) => index >= gameNumber && slot === null) : -1
  return { kind: 'save', points: entry.points, next: next === -1 ? null : next + 1 }
}

// The games padded with empty slots up to the match's best of.
export function slotsOf(games: readonly GamePoints[], bestOf: BestOf): (GamePoints | null)[] {
  return Array.from({ length: bestOf }, (_, index) => games[index] ?? null)
}
