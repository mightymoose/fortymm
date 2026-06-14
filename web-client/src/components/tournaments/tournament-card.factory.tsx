import { buildTournament } from './data/seed.factory'
import type { TournamentCardProps } from './tournament-card'

/** Props for `TournamentCard` — the seeded Bay Area Open, with no-op handlers. */
export function buildTournamentCardProps(
  overrides: Partial<TournamentCardProps> = {},
): TournamentCardProps {
  return {
    tournament: buildTournament(),
    onOpen: () => {},
    onDelete: () => {},
    ...overrides,
  }
}
