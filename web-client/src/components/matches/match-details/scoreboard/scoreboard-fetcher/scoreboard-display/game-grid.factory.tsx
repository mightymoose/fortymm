import type { GameGridProps } from "./game-grid";
import {
  buildScoredCellView,
  buildUnplayedCellView,
} from "./game-grid/game-grid-row/game-grid-cell.factory";
import { buildGameGridRowView } from "./game-grid/game-grid-row.factory";
import type { GameGridView } from "../scoreboard-query";

/** The projected game-grid view — a live BO5 one game in, viewer's row first. */
export function buildGameGridView(
  overrides: Partial<GameGridView> = {},
): GameGridView {
  return {
    matchId: "m-1",
    bestOf: 5,
    rows: [
      buildGameGridRowView(),
      buildGameGridRowView({
        name: "leo.mertens",
        initials: "LM",
        gamesWon: 0,
        cells: [
          buildScoredCellView({ points: 7, won: false }),
          buildUnplayedCellView({ isLive: true }),
          buildUnplayedCellView(),
          buildUnplayedCellView(),
          buildUnplayedCellView(),
        ],
      }),
    ],
    ...overrides,
  };
}

/** Props for `GameGrid`. */
export function buildGameGridProps(
  overrides: Partial<GameGridProps> = {},
): GameGridProps {
  return {
    gameGrid: buildGameGridView(),
    ...overrides,
  };
}
