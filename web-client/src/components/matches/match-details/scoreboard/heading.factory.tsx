import type { ScoreboardHeadingView } from "./scoreboard-query";
import type { HeadingProps } from "./heading";
import { buildStatusChipView } from "./status-chip.factory";

/** The projected heading-strip view the display renders. */
export function buildScoreboardHeadingView(
  overrides: Partial<ScoreboardHeadingView> = {},
): ScoreboardHeadingView {
  return {
    chip: buildStatusChipView(),
    formatLabel: "SINGLES · BO5",
    raceLabel: "First to 3",
    ...overrides,
  };
}

/** Props for `Heading`. */
export function buildHeadingProps(
  overrides: Partial<HeadingProps> = {},
): HeadingProps {
  return {
    heading: buildScoreboardHeadingView(),
    ...overrides,
  };
}
