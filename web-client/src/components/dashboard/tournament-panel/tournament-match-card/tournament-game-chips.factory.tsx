import type { TournamentGameChipView } from '../../tournament-panel-view'
import type { TournamentGameChipsProps } from './tournament-game-chips'

/** `Game 1 · 11–7`, the viewer's points first. */
export function buildTournamentGameChipView(
  overrides: Partial<TournamentGameChipView> = {},
): TournamentGameChipView {
  return {
    label: 'Game 1',
    score: '11–7',
    description: 'Game 1: mightymoose 11, slim-manatee 7',
    ...overrides,
  }
}

/** Three played games of a best-of-five, viewer 2–1 up. */
export function buildTournamentGameChipsProps(
  overrides: Partial<TournamentGameChipsProps> = {},
): TournamentGameChipsProps {
  return {
    legend: 'mightymoose shown first · vs slim-manatee',
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
    ...overrides,
  }
}
