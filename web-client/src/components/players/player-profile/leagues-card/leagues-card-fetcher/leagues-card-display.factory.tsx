import {
  FORTYMM_LEAGUE_ID,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-league.factory'

import type { LeaguesCardDisplayProps } from './leagues-card-display'
import type { LeagueRowView, LeaguesView } from './leagues-card-query'

/** The default league's row — FortyMM, selected, 1687. The row a real player
 * sees today, and the one the page falls back to when the URL names none. */
export function buildLeagueRowView(
  overrides: Partial<LeagueRowView> = {},
): LeagueRowView {
  return {
    id: FORTYMM_LEAGUE_ID,
    name: 'FortyMM',
    rating: '1687',
    isDefault: true,
    isSelected: true,
    ...overrides,
  }
}

/** The second league's row — USATT, unselected, and rated **differently** (1642).
 * The different rating is the point: two ladders, two ratings, no single number
 * to show (ADR-0915). */
export function buildSecondLeagueRowView(
  overrides: Partial<LeagueRowView> = {},
): LeagueRowView {
  return buildLeagueRowView({
    id: USATT_LEAGUE_ID,
    name: 'USATT',
    rating: '1642',
    isDefault: false,
    isSelected: false,
    ...overrides,
  })
}

/** Two leagues, the default one selected — the multi-league shape the switcher
 * exists for. */
export function buildLeaguesView(
  overrides: Partial<LeaguesView> = {},
): LeaguesView {
  return {
    rows: [buildLeagueRowView(), buildSecondLeagueRowView()],
    ...overrides,
  }
}

/** The shape of every real player today: one league, the default, selected. The
 * card still renders — hiding it would delete the affordance the page needs the
 * day a second league lands. */
export function buildSingleLeagueView(
  overrides: Partial<LeaguesView> = {},
): LeaguesView {
  return buildLeaguesView({ rows: [buildLeagueRowView()], ...overrides })
}

/** Props for `LeaguesCardDisplay`. */
export function buildLeaguesCardDisplayProps(
  overrides: Partial<LeaguesCardDisplayProps> = {},
): LeaguesCardDisplayProps {
  return { leagues: buildLeaguesView(), playerId: 'p-1', ...overrides }
}
