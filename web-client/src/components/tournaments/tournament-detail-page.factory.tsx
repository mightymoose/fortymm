import { buildTables, buildTournament } from './data/seed.factory'
import type { TournamentDetailPageProps } from './tournament-detail-page'

/** Props for `TournamentDetailPage` — the seeded Bay Area Open with no-op
 * handlers and the full 12-table catalogue. */
export function buildTournamentDetailPageProps(
  overrides: Partial<TournamentDetailPageProps> = {},
): TournamentDetailPageProps {
  return {
    tournament: buildTournament(),
    tournamentDetailUpdatedAt: 1,
    allTables: buildTables(12),
    onUpdate: async () => {},
    onChangeCatalogue: async () => {},
    onCreateEvent: async () => {},
    onUpdateEvent: async () => {},
    onDeleteEvent: () => {},
    savingEvent: false,
    onBack: () => {},
    // No editor open, and the two navigations stubbed: a component test drives the
    // page's props, and which editor is open is the ROUTE's fact (#1503). The
    // URL-driven behaviour is proved where a real router lives —
    // `routes/_app/tournaments.$tournamentId.test.tsx`.
    openEditorFor: undefined,
    onOpenEditor: () => {},
    onCloseEditor: () => {},
    ...overrides,
  }
}
