import { buildPlayerMatchRow } from '@/mocks/factories/players/player-match-row.factory'

import type { MatchHistoryRowProps } from './match-history-row'

/** A real match id — a **UUID**, as the API emits them and as the `$matchId`
 * route guard (`src/lib/match-id.ts`) demands. The row's link is asserted by its
 * `href`, so the id behind it has to be a plausible one. */
export const HISTORY_MATCH_ID = 'e93a6b27-51fc-4d80-b2a5-7c0d4e8f1936'

/** The href that id must produce. */
export const HISTORY_MATCH_HREF = `/matches/${HISTORY_MATCH_ID}`

/**
 * Props for `MatchHistoryRow`: one wire row, defaulting to the shared
 * `buildPlayerMatchRow` (a completed, rated win against ada.lovelace on Mar 14)
 * with a real match id. Reach for the other builders in that module —
 * `buildSoloMatchRow`, `buildLiveMatchRow`, … — for the other states.
 */
export function buildMatchHistoryRowProps(
  overrides: Partial<MatchHistoryRowProps> = {},
): MatchHistoryRowProps {
  return {
    match: buildPlayerMatchRow({ id: HISTORY_MATCH_ID }),
    ...overrides,
  }
}
