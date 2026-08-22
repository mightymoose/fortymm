import { buildTournamentPathRowView } from './tournament-path-list/tournament-path-row.factory'
import type { TournamentPathListProps } from './tournament-path-list'

/**
 * A three-match group schedule mid-run: one won, one being played, one to come.
 * Deliberately not all-one-state — a list where every row is identical cannot
 * show that the rows are driven by their own view.
 */
export function buildTournamentPathListProps(
  overrides: Partial<TournamentPathListProps> = {},
): TournamentPathListProps {
  return {
    heading: 'Your matches',
    subheading: 'Group A · 4 players',
    rows: [
      buildTournamentPathRowView({ key: 'r1', label: 'M1' }),
      buildTournamentPathRowView({
        key: 'r2',
        label: 'M2',
        opponentName: 'slim-manatee',
        state: 'live',
        detail: 'In progress',
        youWon: null,
      }),
      buildTournamentPathRowView({
        key: 'r3',
        label: 'M3',
        opponentName: 'bold-bison',
        state: 'upcoming',
        detail: '5:20 PM CDT · Table 6',
        youWon: null,
      }),
    ],
    ...overrides,
  }
}
