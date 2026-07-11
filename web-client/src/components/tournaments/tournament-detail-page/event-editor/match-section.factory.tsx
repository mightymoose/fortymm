import { buildEvent } from '../../data/seed.factory'
import type { MatchSectionProps } from './match-section'

/** Props for `MatchSection` — a rated Bo5 event, editable (the creator's
 * view). Pass `canEdit: false` for a viewer's read-only rendering. */
export function buildMatchSectionProps(
  overrides: Partial<MatchSectionProps> = {},
): MatchSectionProps {
  return {
    event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
    canEdit: true,
    onChange: () => {},
    ...overrides,
  }
}
