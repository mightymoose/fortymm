import type { components } from '@/api/schema'

type MatchDetailsData =
  components['schemas']['app__schemas__view__match_details__MatchDetails']
type Scoreboard = components['schemas']['Scoreboard']

/** The scoreboard widget block within a match-details payload. */
export function buildScoreboard(
  overrides: Partial<Scoreboard> = {},
): Scoreboard {
  return {
    status: 'scheduled',
    ...overrides,
  }
}

/**
 * The `data` block of a `GET /v1/matches/{match_id}` payload — the per-page
 * view bag that nests the scoreboard widget.
 */
export function buildMatchDetailsData(
  overrides: Partial<MatchDetailsData> = {},
): MatchDetailsData {
  return {
    scoreboard: buildScoreboard(),
    ...overrides,
  }
}

export type { MatchDetailsData, Scoreboard }
