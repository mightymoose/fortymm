import { buildTournament } from './data/seed.factory'
import type { TournamentsListPageProps } from './tournaments-list-page'

/** Props for `TournamentsListPage` — a published, a draft, and an archived
 * tournament, with no-op handlers. */
export function buildTournamentsListPageProps(
  overrides: Partial<TournamentsListPageProps> = {},
): TournamentsListPageProps {
  return {
    tournaments: [
      buildTournament({ id: 'bay', name: 'Bay Area Open 2026', status: 'published' }),
      buildTournament({ id: 'slam', name: 'Summer Slam 2026', status: 'draft', events: [] }),
      buildTournament({ id: 'winter', name: 'Winter Classic 2025', status: 'archived', events: [] }),
    ],
    onOpen: () => {},
    onCreate: () => {},
    onDelete: () => {},
    canCreate: true,
    onNearMeChange: () => {},
    ...overrides,
  }
}
