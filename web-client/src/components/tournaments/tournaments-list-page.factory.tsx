import { buildTournament } from './data/seed.factory'
import type { TournamentsListPageProps } from './tournaments-list-page'

/** Props for `TournamentsListPage` — one tournament of **every** `TournamentStatus`,
 * with no-op handlers.
 *
 * One per status on purpose: a fixture missing a status cannot catch a filter tab that
 * fails to find it, which is the whole of #970 (the `live` row had no tab, and no test
 * held a `live` row to notice). Each tab has exactly one match here, so a tab that
 * over- or under-matches shows up as a card count. */
export function buildTournamentsListPageProps(
  overrides: Partial<TournamentsListPageProps> = {},
): TournamentsListPageProps {
  return {
    tournaments: [
      buildTournament({ id: 'bay', name: 'Bay Area Open 2026', status: 'published' }),
      buildTournament({ id: 'slam', name: 'Summer Slam 2026', status: 'draft', events: [] }),
      buildTournament({ id: 'autumn', name: 'Autumn Cup 2026', status: 'live', events: [] }),
      buildTournament({ id: 'winter', name: 'Winter Classic 2025', status: 'archived', events: [] }),
    ],
    onOpen: () => {},
    onCreate: () => {},
    onDelete: () => {},
    canCreate: true,
    onNearMeChange: () => {},
    nearMeActive: false,
    ...overrides,
  }
}
