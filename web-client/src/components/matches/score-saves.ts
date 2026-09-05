import {
  useMutationState,
  useQuery,
  type Mutation,
} from '@tanstack/react-query'
import {
  readScoreSaveContext,
  scoreBaselineConflict,
  type ScoreSaveContext,
} from '@/api/score-save-baseline'
import { ApiError, conflictDetail } from '@/api/client'
import {
  gameNumberFromScoreMutationKey,
  matchScoreMutationPrefix,
  scoreMutationKey,
  matchQueryOptions,
  type MatchGameScoreWrite,
} from '@/api/matches'

/** A failed save is a *conflict* (vs. a network/server failure) when the
 * server rejected the write because a concurrent participant had already saved
 * this game — a 409/412 carrying the committed score (`conflictDetail`). These
 * must never be blindly retried: re-firing would re-issue the write against
 * fresh state and silently overwrite the other save. The user resolves them
 * against the committed value instead. A plain-string 409 (e.g. a locked match)
 * is NOT a conflict — it's an ordinary failed save. */
export function isScoreConflict(error: ApiError | null | undefined): boolean {
  return error instanceof ApiError && conflictDetail(error) !== null
}

/**
 * View-model hooks over the per-game score-save mutations (`scoreMutationKey`).
 *
 * The shared React Query mutation cache *is* the failed-save store: each game's
 * scratch save is its own keyed mutation, so a cell can read its own latest
 * save state (saving / failed / saved) and the entered points without any
 * prop-drilled side store. A retry is just another mutation under the same key,
 * so "latest wins" — a successful re-save supersedes an older failure even
 * though the failed mutation lingers in the cache until it's garbage-collected.
 */

export type GameSaveStatus = 'idle' | 'pending' | 'success' | 'error'

export interface GameSaveState {
  status: GameSaveStatus
  /** The points last submitted for this game — shown in the cell while it's
   * saving or failed (they're the scratch data a retry re-sends). */
  variables: MatchGameScoreWrite | null
  /** The error a failed save settled with — `null` unless `status === 'error'`.
   * A 409/412 here is a concurrency conflict (`isScoreConflict`), which the UI
   * surfaces distinctly from an ordinary failed save. */
  error: ApiError | null
  submittedAt: number
  context?: ScoreSaveContext
}

const asApiError = (error: unknown): ApiError | null =>
  error instanceof ApiError ? error : null

// Stable, module-level selectors so the per-cell / per-render subscriptions
// don't allocate a fresh closure each time.
const selectGameSaveState = (mutation: Mutation): GameSaveState => ({
  status: mutation.state.status as GameSaveStatus,
  variables:
    (mutation.state.variables as MatchGameScoreWrite | undefined) ?? null,
  error: asApiError(mutation.state.error),
  submittedAt: mutation.state.submittedAt,
  context: readScoreSaveContext(mutation.state.context),
})

interface ScoreSaveProbe {
  gameNumber: number | null
  status: GameSaveStatus
  variables: MatchGameScoreWrite | undefined
  error: ApiError | null
  submittedAt: number
  context?: ScoreSaveContext
}
const selectScoreSaveProbe = (mutation: Mutation): ScoreSaveProbe => ({
  gameNumber: gameNumberFromScoreMutationKey(mutation.options.mutationKey),
  status: mutation.state.status as GameSaveStatus,
  variables: mutation.state.variables as MatchGameScoreWrite | undefined,
  error: asApiError(mutation.state.error),
  submittedAt: mutation.state.submittedAt,
  context: readScoreSaveContext(mutation.state.context),
})

/** Latest score-save state for a single game, or `null` if it's never been
 * saved this session. Reads the shared mutation cache, so it reflects a save
 * fired from any screen — including the one that already navigated away. */
export function useGameSaveState(
  matchId: string,
  gameNumber: number,
): GameSaveState | null {
  // Observe server truth without initiating another request. A failed save's
  // conflict classification must update when the open match refetches.
  const { data } = useQuery({ ...matchQueryOptions(matchId), enabled: false })
  const states = useMutationState({
    filters: {
      mutationKey: scoreMutationKey(matchId, gameNumber),
      exact: true,
    },
    select: selectGameSaveState,
  })
  const latest = states.at(-1)
  if (!latest) return null
  const committed =
    data?.games.find((game) => game.game_number === gameNumber)?.score ?? null
  return latest.status === 'error' && data
    ? {
        ...latest,
        error: scoreBaselineConflict(latest.context, committed) ?? latest.error,
      }
    : latest
}

export interface FailedGameSave {
  gameNumber: number
  variables: MatchGameScoreWrite
  /** True when the failure is a concurrency conflict (409/412), not a network/
   * server error. Conflicts can't be blindly retried (that would overwrite the
   * concurrent save) — the banner routes them to a review-against-committed
   * flow instead of its retry button. */
  conflict: boolean
  /** When this failed save was fired. A re-failure of the same game produces a
   * fresh timestamp, letting callers tell "the same game failed again" apart
   * from "nothing changed" — the failed-save banner folds this into its dismiss
   * key so a dismissed banner re-surfaces when a retry fails anew (#528). */
  submittedAt: number
}

/**
 * Games whose *latest* score-save failed, oldest-submitted first. Latest-per-
 * game so a successful retry (or a fresh save) supersedes an earlier failure
 * without having to evict it from the cache. Drives the failure banner's copy
 * ("Game 3 didn't save." vs "2 games didn't save.") and its retry-all.
 */
export function useFailedGameSaves(matchId: string): FailedGameSave[] {
  const { data } = useQuery({ ...matchQueryOptions(matchId), enabled: false })
  const states = useMutationState({
    filters: { mutationKey: matchScoreMutationPrefix(matchId) },
    select: selectScoreSaveProbe,
  })

  const latestPerGame = new Map<number, ScoreSaveProbe>()
  for (const state of states) {
    if (state.gameNumber == null) continue
    const prev = latestPerGame.get(state.gameNumber)
    if (!prev || state.submittedAt >= prev.submittedAt) {
      latestPerGame.set(state.gameNumber, state)
    }
  }

  return [...latestPerGame.values()]
    .filter((state) => state.status === 'error' && state.variables != null)
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .map((state) => ({
      gameNumber: state.gameNumber as number,
      variables: state.variables as MatchGameScoreWrite,
      conflict:
        isScoreConflict(state.error) ||
        (data != null &&
          scoreBaselineConflict(
            state.context,
            data.games.find((game) => game.game_number === state.gameNumber)
              ?.score ?? null,
          ) !== null),
      submittedAt: state.submittedAt,
    }))
}
