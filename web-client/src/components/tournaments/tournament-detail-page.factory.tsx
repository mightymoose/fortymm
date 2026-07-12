import { buildTables, buildTournament } from './data/seed.factory'
import type { TournamentDetailPageProps } from './tournament-detail-page'

/** Props for `TournamentDetailPage` — the seeded Bay Area Open with no-op
 * handlers and the full 12-table catalogue. */
export function buildTournamentDetailPageProps(
  overrides: Partial<TournamentDetailPageProps> = {},
): TournamentDetailPageProps {
  return {
    tournament: buildTournament(),
    allTables: buildTables(12),
    onUpdate: () => {},
    onChangeCatalogue: () => {},
    onCreateEvent: async () => {},
    onUpdateEvent: async () => {},
    onDeleteEvent: () => {},
    onBack: () => {},
    ...overrides,
  }
}
