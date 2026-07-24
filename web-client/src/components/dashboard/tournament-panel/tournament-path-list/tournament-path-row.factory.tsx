import type { TournamentPathRowView } from '../../tournament-panel-view'
import type { TournamentPathRowProps } from './tournament-path-row'

/** A won first group match — `M1 · celestial-caracara · Won 3–1`. */
export function buildTournamentPathRowView(
  overrides: Partial<TournamentPathRowView> = {},
): TournamentPathRowView {
  return {
    key: 'e-1-0',
    label: 'M1',
    opponentName: 'celestial-caracara',
    state: 'completed',
    detail: 'Won 3–1',
    youWon: true,
    ...overrides,
  }
}

/** Props for `TournamentPathRow`. */
export function buildTournamentPathRowProps(
  overrides: Partial<TournamentPathRowProps> = {},
): TournamentPathRowProps {
  return { row: buildTournamentPathRowView(), ...overrides }
}
