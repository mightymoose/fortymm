import type { FinalizeCalloutDisplayProps } from "./finalize-callout-display";
import type { FinalizeCalloutView } from "./finalize-callout-query";

/** A decided best-of-5 swept 3–0 (11-7, 11-9, 11-5), saved but not yet
 * posted — the canonical "scores ready" board behind the callout. */
export function buildFinalizeCalloutView(
  overrides: Partial<FinalizeCalloutView> = {},
): FinalizeCalloutView {
  return {
    games: [
      { game_number: 1, side_1_points: 11, side_2_points: 7 },
      { game_number: 2, side_1_points: 11, side_2_points: 9 },
      { game_number: 3, side_1_points: 11, side_2_points: 5 },
    ],
    ...overrides,
  };
}

/** Props for `FinalizeCalloutDisplay` — idle (not pending, no error). */
export function buildFinalizeCalloutDisplayProps(
  overrides: Partial<FinalizeCalloutDisplayProps> = {},
): FinalizeCalloutDisplayProps {
  return {
    pending: false,
    errorMessage: null,
    onPost: () => {},
    ...overrides,
  };
}
