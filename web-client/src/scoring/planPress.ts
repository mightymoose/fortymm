import { reviewBoard, type BestOf, type GamePoints, type ScoreEntry } from './board'
import type { Viewer } from './demoMatches'
import { slotsOf, type Board } from './scratchpad'

// What the pad's button does when pressed.
export type Press =
  | { kind: 'disabled' }
  // `next` is the game to open after saving, or null to stay.
  | { kind: 'save'; points: GamePoints; next: number | null }

// A legal score saves.
export function planPress(
  board: Board,
  _viewer: Viewer,
  gameNumber: number,
  entry: ScoreEntry,
  bestOf: BestOf,
): Press {
  if (board.submission.phase === 'submitted') return { kind: 'disabled' }
  const slots = slotsOf(board, bestOf)
  if (entry.kind === 'legal') slots[gameNumber - 1] = entry.points
  const review = reviewBoard(slots, bestOf)
  if (entry.kind !== 'legal') return { kind: 'disabled' }
  // Once the match is decided, the next empty game would only be an extra one.
  const next = review.kind === 'undecided' ? slots.findIndex((slot, index) => index >= gameNumber && slot === null) : -1
  return { kind: 'save', points: entry.points, next: next === -1 ? null : next + 1 }
}
