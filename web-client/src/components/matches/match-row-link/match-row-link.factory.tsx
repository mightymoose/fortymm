import { matchDetailRoute } from '@/api/matches'

import type { MatchRowLinkProps } from './match-row-link'
import { matchRowAriaLabel } from './match-row-naming'

/**
 * A real match id — a **UUID**, as the API emits and as the `$matchId` route
 * guard (`src/lib/match-id.ts`) demands. Tests assert the anchor's `href` against
 * it: "there is a link" was never the claim, "it points at `/matches/<uuid>`" is.
 */
export const MATCH_ID = '2f8a1c4d-6b3e-4f7a-9c2d-5e1b8a0f3c47'

/** The href that id must produce. */
export const MATCH_HREF = `/matches/${MATCH_ID}`

export function buildMatchRowLinkProps(
  overrides: Partial<MatchRowLinkProps> = {},
): MatchRowLinkProps {
  return {
    route: matchDetailRoute(MATCH_ID),
    ariaLabel: matchRowAriaLabel({
      opponent: 'ada.lovelace',
      isSolo: false,
      when: 'Mar 14',
    }),
    when: 'Mar 14',
    ...overrides,
  }
}
