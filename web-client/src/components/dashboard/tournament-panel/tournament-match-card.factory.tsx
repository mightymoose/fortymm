import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import type { TournamentMatchCardView } from '../tournament-panel-view'
import { buildTournamentGameChipView } from './tournament-match-card/tournament-game-chips.factory'
import type { TournamentMatchCardProps } from './tournament-match-card'

/**
 * A live best-of-five on Table 4, three games played, the viewer 2–1 up and
 * about to enter game 4 — the design's headline scenario.
 */
export function buildTournamentMatchCardView(
  overrides: Partial<TournamentMatchCardView> = {},
): TournamentMatchCardView {
  return {
    state: 'live',
    statusText: 'Live · Table 4 · Game 4',
    bestOfText: 'Best of 5',
    youName: 'mightymoose',
    opponentName: 'slim-manatee',
    yourGames: 2,
    opponentGames: 1,
    youWon: false,
    opponentWon: false,
    gamesLegend: 'mightymoose shown first · vs slim-manatee',
    games: [
      buildTournamentGameChipView(),
      buildTournamentGameChipView({
        label: 'Game 2',
        score: '8–11',
        description: 'Game 2: mightymoose 8, slim-manatee 11',
      }),
      buildTournamentGameChipView({
        label: 'Game 3',
        score: '11–9',
        description: 'Game 3: mightymoose 11, slim-manatee 9',
      }),
    ],
    action: {
      label: 'Enter Game 4 result',
      route: scoringNewRoute('m-1', 4),
    },
    detailsRoute: matchDetailRoute('m-1'),
    scheduleText: null,
    ...overrides,
  }
}

/** Props for `TournamentMatchCard`. */
export function buildTournamentMatchCardProps(
  overrides: Partial<TournamentMatchCardProps> = {},
): TournamentMatchCardProps {
  return { match: buildTournamentMatchCardView(), ...overrides }
}
