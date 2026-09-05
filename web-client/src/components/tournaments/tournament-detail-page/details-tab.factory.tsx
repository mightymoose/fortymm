import { buildTournament } from '../data/seed.factory'
import type { DetailsTabProps } from './details-tab'

/** Props for `DetailsTab` — the seeded tournament. Rendered standalone the tab
 * IS the one in view; the hidden-panel tests override `active: false`. */
export function buildDetailsTabProps(
  overrides: Partial<DetailsTabProps> = {},
): DetailsTabProps {
  return {
    tournament: buildTournament(),
    canEdit: true,
    active: true,
    onUpdate: async () => {},
    ...overrides,
  }
}
