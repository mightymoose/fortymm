import {
  buildRatingRowChangeView,
  buildRatingRowView,
} from "./ratings-display/rating-row.factory";
import type { RatingsDisplayProps } from "./ratings-display";
import type { RatingsView } from "./ratings-query";

/** A finished rated match: rita.kovac up 12, leo.mertens down 12. */
export function buildRatingsView(
  overrides: Partial<RatingsView> = {},
): RatingsView {
  return {
    rows: [
      buildRatingRowView(),
      buildRatingRowView({
        username: "leo.mertens",
        initials: "LM",
        won: false,
        change: buildRatingRowChangeView({
          from: 1540,
          to: 1528,
          deltaLabel: "-12",
          deltaUp: false,
          sparkline: [1551, 1546, 1540, 1528],
        }),
      }),
    ],
    ...overrides,
  };
}

/** Props for `RatingsDisplay`. */
export function buildRatingsDisplayProps(
  overrides: Partial<RatingsDisplayProps> = {},
): RatingsDisplayProps {
  return { ratings: buildRatingsView(), ...overrides };
}
