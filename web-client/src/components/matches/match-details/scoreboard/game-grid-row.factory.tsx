import {
  buildScoredCellView,
  buildUnplayedCellView,
} from "./game-grid-cell.factory";
import type { GameGridRowProps } from "./game-grid-row";
import type { GameGridRowView } from "./scoreboard-query";

/** One side's row of the grid. */
export function buildGameGridRowView(
  overrides: Partial<GameGridRowView> = {},
): GameGridRowView {
  return {
    name: "rita.kovac",
    initials: "RK",
    isGhost: false,
    won: false,
    gamesWon: 1,
    cells: [
      buildScoredCellView(),
      buildUnplayedCellView({ isLive: true }),
      buildUnplayedCellView(),
      buildUnplayedCellView(),
      buildUnplayedCellView(),
    ],
    ...overrides,
  };
}

/** Props for `GameGridRow` — the viewer's row of a live BO5 one game in. */
export function buildGameGridRowProps(
  overrides: Partial<GameGridRowProps> = {},
): GameGridRowProps {
  return {
    row: buildGameGridRowView(),
    rowSide: "left",
    matchId: "m-1",
    ...overrides,
  };
}
