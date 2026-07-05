import { describe, expect, it } from 'vitest'
import type { GamePoints } from '@/lib/scoring'
import { reconstructBoard } from './reconstruct-board'
import type { FailedGameSave } from './score-saves'

function persisted(
  gameNumber: number,
  side_1_points: number,
  side_2_points: number,
): GamePoints {
  return { game_number: gameNumber, side_1_points, side_2_points }
}

function failed(
  gameNumber: number,
  side_1_points: number,
  side_2_points: number,
  conflict = false,
): FailedGameSave {
  return {
    gameNumber,
    variables: { side_1_points, side_2_points },
    conflict,
    submittedAt: gameNumber,
  }
}

const byNumber = (games: GamePoints[]) =>
  new Map(games.map((g) => [g.game_number, g]))

describe('reconstructBoard', () => {
  it('returns the persisted games when nothing else is present', () => {
    const board = reconstructBoard({
      persisted: [persisted(1, 11, 5), persisted(2, 8, 11)],
      failedSaves: [],
    })
    expect(byNumber(board).get(1)).toEqual(persisted(1, 11, 5))
    expect(byNumber(board).get(2)).toEqual(persisted(2, 8, 11))
  })

  it('folds in a failed scratch save that was never persisted (the #747-F2 hole)', () => {
    // G1 persisted (win side 1), G2 FAILED (win side 2), no persisted G2.
    // Without folding the failed save, G2 vanishes and the board reads 1-0.
    const board = reconstructBoard({
      persisted: [persisted(1, 11, 5)],
      failedSaves: [failed(2, 7, 11)],
    })
    expect(byNumber(board).get(2)).toEqual(persisted(2, 7, 11))
    expect(board).toHaveLength(2)
  })

  it('lets a failed scratch save override a stale persisted score for the same game', () => {
    // Failed save is newer than the persisted score — precedence failed > persisted.
    const board = reconstructBoard({
      persisted: [persisted(1, 11, 5)],
      failedSaves: [failed(1, 11, 9)],
    })
    expect(byNumber(board).get(1)).toEqual(persisted(1, 11, 9))
    expect(board).toHaveLength(1)
  })

  it('lets the active live input win over both a failed save and the persisted score', () => {
    // Precedence live > failed > persisted, all on the same game — the last
    // overlay (activeInput) wins. Callers need not strip the active game from
    // failedSaves because of this.
    const board = reconstructBoard({
      persisted: [persisted(1, 11, 5)],
      failedSaves: [failed(1, 11, 9)],
      activeInput: persisted(1, 12, 10),
    })
    expect(byNumber(board).get(1)).toEqual(persisted(1, 12, 10))
    expect(board).toHaveLength(1)
  })

  it('adds the active input as a new game when it has no prior score', () => {
    const board = reconstructBoard({
      persisted: [persisted(1, 11, 5)],
      failedSaves: [failed(2, 7, 11)],
      activeInput: persisted(3, 11, 9),
    })
    expect(board).toHaveLength(3)
    expect(byNumber(board).get(3)).toEqual(persisted(3, 11, 9))
  })
})
