import type { GamePoints } from '@/lib/scoring'
import type { MatchDetails } from '@/api/matches'
import type { FailedGameSave } from './score-saves'

/** The persisted per-game scores as `GamePoints` — drops un-scored games and
 * the side orientation, the shape the scoring lib
 * (`deciderGameNumber`/`overrunDecider`/`reconstructBoard`) expects. The single
 * source of the persisted → board mapping, shared by both finalize surfaces so
 * the two can't drift (ADR 0004). */
export function scoredGamePoints(games: MatchDetails['games']): GamePoints[] {
  return games
    .filter((g) => g.score)
    .map((g) => ({
      game_number: g.game_number,
      side_1_points: g.score!.side_1_points,
      side_2_points: g.score!.side_2_points,
    }))
}

/**
 * Reconstruct the candidate decided board from every source a game's newest
 * score can live in, so a finalize surface can never mint a board missing a
 * played game (ADR 0004). The three sources, lowest precedence first:
 *
 * 1. `persisted` — the committed per-game scores (map via `scoredGamePoints`).
 * 2. `failedSaves` — per-game scratch saves that never reached the server, held
 *    in the shared mutation cache (`useFailedGameSaves`). Newer than the
 *    persisted score for the same game.
 * 3. `activeInput` — the active game's live typed input. Newest of all; only
 *    `score-entry` can pass it (the banner may be on another game's screen).
 *
 * They are overlaid in that order, so per game number the precedence is
 * `live input > failed scratch > persisted` — a later source wins. That is why
 * a caller need NOT pre-filter the active game out of `failedSaves`: an
 * `activeInput` for the same game overwrites it here.
 *
 * Two deliberate non-responsibilities, both owned by the caller:
 *
 * - **Conflicts are excluded by the caller**, not here. A conflicted failed
 *   save's committed value is already in `persisted`; folding the *rejected*
 *   scratch back in would re-introduce the last-write-wins overwrite the version
 *   guard prevents. Callers pass `useFailedGameSaves(...).filter(!conflict)`.
 * - **The board is returned raw, not compacted.** `score-entry` needs the
 *   un-compacted board for `overrunDecider` (which reports the true game
 *   number), and both callers already own their `compactGames` call.
 */
export function reconstructBoard({
  persisted,
  failedSaves,
  activeInput,
}: {
  persisted: GamePoints[]
  failedSaves: FailedGameSave[]
  activeInput?: GamePoints | null
}): GamePoints[] {
  const byNumber = new Map<number, GamePoints>()
  for (const game of persisted) {
    byNumber.set(game.game_number, game)
  }
  for (const entry of failedSaves) {
    byNumber.set(entry.gameNumber, {
      game_number: entry.gameNumber,
      side_1_points: entry.variables.side_1_points,
      side_2_points: entry.variables.side_2_points,
    })
  }
  if (activeInput) {
    byNumber.set(activeInput.game_number, activeInput)
  }
  return [...byNumber.values()]
}
