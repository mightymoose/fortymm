import { buildTournamentMatchCardView } from './tournament-panel/tournament-match-card.factory'
import { buildTournamentStatsView } from './tournament-panel/tournament-stats-strip.factory'
import { buildTournamentPathRowView } from './tournament-panel/tournament-path-list/tournament-path-row.factory'
import type { TournamentPanelProps } from './tournament-panel'
import type {
  TournamentPanelView,
  TournamentTabView,
} from './tournament-panel-view'

/**
 * The viewer's live event: a four-strong group they lead, one match won, one
 * being played right now, one still to come.
 */
export function buildTournamentTabView(
  overrides: Partial<TournamentTabView> = {},
): TournamentTabView {
  return {
    eventId: 'e-1',
    name: 'U1500 · Group B',
    live: true,
    stats: buildTournamentStatsView(),
    match: buildTournamentMatchCardView(),
    pathHeading: 'Your matches',
    pathSubheading: 'Pool B · 4 players',
    path: [
      buildTournamentPathRowView({ key: 'e-1-0', label: 'M1' }),
      buildTournamentPathRowView({
        key: 'e-1-1',
        label: 'M2',
        opponentName: 'slim-manatee',
        state: 'live',
        detail: 'In progress',
        youWon: null,
      }),
      buildTournamentPathRowView({
        key: 'e-1-2',
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

/**
 * A one-event panel for a live tournament — the single-tab case, which is what
 * a player entered in one event actually sees. Multi-tab cases pass their own
 * `tabs`.
 */
export function buildTournamentPanelView(
  overrides: Partial<TournamentPanelView> = {},
): TournamentPanelView {
  return {
    tournamentId: 't-1',
    name: 'Riverside Summer Slam',
    subtitle: 'Riverside TTC · Jul 24–25',
    liveLabel: '1 live now',
    destinationLabel: 'View group & standings',
    tabs: [buildTournamentTabView()],
    ...overrides,
  }
}

/** Props for `TournamentPanel`. */
export function buildTournamentPanelProps(
  overrides: Partial<TournamentPanelProps> = {},
): TournamentPanelProps {
  return { view: buildTournamentPanelView(), ...overrides }
}
