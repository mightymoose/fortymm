import type { ScoreCellProps, ScoreCellView } from "./score-cell";

/** A completed match showing 2–1 in games. Pass `games: null` for the absent
 * variant that renders as a pending em-dash. */
export function buildScoreCellView(
  overrides: Partial<ScoreCellView> = {},
): ScoreCellView {
  return {
    games: "2–1",
    ...overrides,
  };
}

/** Props for `ScoreCell` — a completed match showing 2–1 in games. */
export function buildScoreCellProps(
  overrides: Partial<ScoreCellProps> = {},
): ScoreCellProps {
  return {
    score: buildScoreCellView(),
    ...overrides,
  };
}
