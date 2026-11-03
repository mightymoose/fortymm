import { reviewBoard, type BestOf, type GamePoints, type ScoreEntry, type Side } from './board'
import type { Viewer } from './demoMatches'
import { slotsOf, type Board } from './scratchpad'

// What the pad's button does when pressed.
export type Press =
  | { kind: 'disabled' }
  // `next` is the game to open after saving, or null to stay.
  | { kind: 'save'; points: GamePoints; next: number | null }
  // Saves `save` first when the game has a new score, then submits `games`.
  | { kind: 'submit'; save: GamePoints | null; games: GamePoints[]; winner: Side; closedGaps: boolean }

// A player whose press would leave a decided board submits it. Anyone else,
// or a board that isn't decided, saves a legal score.
export function planPress(
  board: Board,
  viewer: Viewer,
  gameNumber: number,
  entry: ScoreEntry,
  bestOf: BestOf,
): Press {
  if (board.submission.phase === 'submitted') return { kind: 'disabled' }
  const slots = slotsOf(board, bestOf)
  if (entry.kind === 'legal') slots[gameNumber - 1] = entry.points
  const review = reviewBoard(slots, bestOf)
  if (viewer.role === 'player' && review.kind === 'decided' && (entry.kind === 'legal' || entry.kind === 'empty')) {
    const saved = board.games[gameNumber]?.points
    const changed = entry.kind === 'legal' && entry.points.some((points, side) => points !== saved?.[side])
    return {
      kind: 'submit',
      save: changed ? entry.points : null,
      games: review.games,
      winner: review.winner,
      closedGaps: review.closedGaps,
    }
  }
  if (entry.kind !== 'legal') return { kind: 'disabled' }
  // Once the match is decided, the next empty game would only be an extra one.
  const next = review.kind === 'undecided' ? slots.findIndex((slot, index) => index >= gameNumber && slot === null) : -1
  return { kind: 'save', points: entry.points, next: next === -1 ? null : next + 1 }
}
