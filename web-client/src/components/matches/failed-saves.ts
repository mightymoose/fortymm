import { useSyncExternalStore } from 'react'
import type { MatchGameScoreWrite } from '@/api/matches'

/**
 * Module-level store for per-game score saves that failed on the server.
 *
 * Per-game saves are fire-and-forget: the app navigates to the next game even
 * when the write 500s (#369), because the canonical POST /results reconciles
 * scores at finalize. The silent part was the bug — so when a save fails we
 * keep the entered points here, mark the game's scoreline cell as failed
 * (tappable, pre-filled retry), and fire a transient flash on the next
 * screen. The store lives outside React because the failure outlives the
 * navigation that unmounts the entry screen that triggered it.
 */

/** The one-shot "Game N didn't save" banner. `id` increments per failure so
 * a repeat failure for the same game re-triggers the flash's timer. */
export interface FailedSaveFlash {
  matchId: string
  gameNumber: number
  id: number
}

interface FailedSavesState {
  /** Entered-but-unsaved points, keyed by `${matchId}:${gameNumber}`. */
  entries: Readonly<Record<string, MatchGameScoreWrite>>
  flash: FailedSaveFlash | null
}

const entryKey = (matchId: string, gameNumber: number) =>
  `${matchId}:${gameNumber}`

let state: FailedSavesState = { entries: {}, flash: null }
let flashCounter = 0
const listeners = new Set<() => void>()

function emit(next: FailedSavesState) {
  state = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Keep a failed write's points and arm the flash for that game. */
export function recordFailedSave(
  matchId: string,
  gameNumber: number,
  score: MatchGameScoreWrite,
) {
  flashCounter += 1
  emit({
    entries: { ...state.entries, [entryKey(matchId, gameNumber)]: score },
    flash: { matchId, gameNumber, id: flashCounter },
  })
}

/** Drop a game's failed entry (save succeeded, or the game was cleared).
 * Also retires the flash if it points at that game. */
export function clearFailedSave(matchId: string, gameNumber: number) {
  const key = entryKey(matchId, gameNumber)
  const flashMatches =
    state.flash !== null &&
    state.flash.matchId === matchId &&
    state.flash.gameNumber === gameNumber
  if (!(key in state.entries) && !flashMatches) return
  const entries = { ...state.entries }
  delete entries[key]
  emit({ entries, flash: flashMatches ? null : state.flash })
}

/** Hide the flash; the failed entry (and its scoreline cell) stays. */
export function dismissSaveFlash() {
  if (state.flash === null) return
  emit({ ...state, flash: null })
}

/** Test-only: wipe everything so suites don't leak failures across tests. */
export function resetFailedSaves() {
  flashCounter = 0
  if (Object.keys(state.entries).length === 0 && state.flash === null) return
  emit({ entries: {}, flash: null })
}

/** The failed entry for one game, or null. */
export function failedSaveFor(
  entries: FailedSavesState['entries'],
  matchId: string,
  gameNumber: number,
): MatchGameScoreWrite | null {
  return entries[entryKey(matchId, gameNumber)] ?? null
}

/** Subscribe to the failed-saves state. */
export function useFailedSaves(): FailedSavesState {
  return useSyncExternalStore(subscribe, () => state)
}
