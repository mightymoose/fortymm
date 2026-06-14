import { buildEvent } from '../../data/seed.factory'
import type { MatchSectionProps } from './match-section'

/** Props for `MatchSection` — a rated Bo5 event. */
export function buildMatchSectionProps(
  overrides: Partial<MatchSectionProps> = {},
): MatchSectionProps {
  return {
    event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
    onChange: () => {},
    ...overrides,
  }
}
