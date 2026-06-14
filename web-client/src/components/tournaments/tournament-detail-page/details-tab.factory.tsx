import { buildTournament } from '../data/seed.factory'
import type { DetailsTabProps } from './details-tab'

/** Props for `DetailsTab` — the seeded tournament. */
export function buildDetailsTabProps(
  overrides: Partial<DetailsTabProps> = {},
): DetailsTabProps {
  return { tournament: buildTournament(), onUpdate: () => {}, ...overrides }
}
