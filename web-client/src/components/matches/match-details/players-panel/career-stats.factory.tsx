import type { CareerStatsProps } from "./career-stats";
import type { CareerStatsView } from "./players-panel-query";

/** A 12-match career at a highlighted 75% win rate. */
export function buildCareerStatsView(
  overrides: Partial<CareerStatsView> = {},
): CareerStatsView {
  return {
    matches: 12,
    winRateLabel: "75%",
    highWinRate: true,
    ...overrides,
  };
}

/** A rookie career — no matches, no win rate. */
export function buildRookieCareerStatsView(
  overrides: Partial<CareerStatsView> = {},
): CareerStatsView {
  return buildCareerStatsView({
    matches: 0,
    winRateLabel: null,
    highWinRate: false,
    ...overrides,
  });
}

/** Props for `CareerStats`. */
export function buildCareerStatsProps(
  overrides: Partial<CareerStatsProps> = {},
): CareerStatsProps {
  return { career: buildCareerStatsView(), ...overrides };
}
