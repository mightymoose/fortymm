import type { TournamentStatsView } from '../tournament-panel-view'
import type { TournamentStatsStripProps } from './tournament-stats-strip'

/** A player leading a four-strong group, one win to nothing, mid-group-play. */
export function buildTournamentStatsView(
  overrides: Partial<TournamentStatsView> = {},
): TournamentStatsView {
  return {
    wins: 1,
    losses: 0,
    positionLabel: 'Group position',
    positionValue: '1st',
    positionSuffix: 'of 4',
    stageValue: 'Group play',
    ...overrides,
  }
}

/** Props for `TournamentStatsStrip`. */
export function buildTournamentStatsStripProps(
  overrides: Partial<TournamentStatsStripProps> = {},
): TournamentStatsStripProps {
  return { stats: buildTournamentStatsView(), ...overrides }
}
