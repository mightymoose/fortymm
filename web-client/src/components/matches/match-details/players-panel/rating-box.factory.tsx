import type { RatingBoxView } from "./players-panel-query";
import type { RatingBoxProps } from "./rating-box";

/** A 1612-rated player with a rising history behind the sparkline. */
export function buildRatingBoxView(
  overrides: Partial<RatingBoxView> = {},
): RatingBoxView {
  return {
    value: 1612,
    sparkline: [1580, 1601, 1612],
    ...overrides,
  };
}

/** An unrated player — no value, no trend to draw. */
export function buildUnratedRatingBoxView(
  overrides: Partial<RatingBoxView> = {},
): RatingBoxView {
  return buildRatingBoxView({ value: null, sparkline: null, ...overrides });
}

/** Props for `RatingBox`. */
export function buildRatingBoxProps(
  overrides: Partial<RatingBoxProps> = {},
): RatingBoxProps {
  return { rating: buildRatingBoxView(), ...overrides };
}
