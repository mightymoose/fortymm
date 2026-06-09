import type { GameGridCellProps } from "./game-grid-cell";
import type { GameGridCellView } from "./scoreboard-query";

/** An unscored slot — a future game, or the live one when `isLive`. */
export function buildUnplayedCellView(
  overrides: Partial<Extract<GameGridCellView, { kind: "unplayed" }>> = {},
): GameGridCellView {
  return {
    kind: "unplayed",
    isLive: false,
    ...overrides,
  };
}

/** A scored slot. Defaults carry no edit link so the cell renders as a plain
 * div — page objects that need the `<Link>` branch must also supply a router
 * (see `gameGridCellPage.render`). */
export function buildScoredCellView(
  overrides: Partial<Extract<GameGridCellView, { kind: "scored" }>> = {},
): GameGridCellView {
  return {
    kind: "scored",
    points: 11,
    won: true,
    editGameNumber: null,
    ...overrides,
  };
}

/** Props for `GameGridCell` — a scored, non-editable game-1 cell on the
 * viewer's row. */
export function buildGameGridCellProps(
  overrides: Partial<GameGridCellProps> = {},
): GameGridCellProps {
  return {
    cell: buildScoredCellView(),
    gameNumber: 1,
    rowSide: "left",
    matchId: "m-1",
    ...overrides,
  };
}
