import type { RatingRowProps } from "./rating-row";
import type { RatingRowChangeView, RatingRowView } from "../ratings-query";

/** A +12 move from 1612 to 1624 with a rising four-point trend line. */
export function buildRatingRowChangeView(
  overrides: Partial<RatingRowChangeView> = {},
): RatingRowChangeView {
  return {
    from: 1612,
    to: 1624,
    deltaLabel: "+12",
    deltaAriaLabel: "Gained 12 rating",
    deltaUp: true,
    sparkline: [1580, 1601, 1612, 1624],
    ...overrides,
  };
}

/** The winning side's row: rita.kovac, up 12 points. */
export function buildRatingRowView(
  overrides: Partial<RatingRowView> = {},
): RatingRowView {
  return {
    username: "rita.kovac",
    initials: "RK",
    won: true,
    change: buildRatingRowChangeView(),
    ...overrides,
  };
}

/** Props for `RatingRow`. */
export function buildRatingRowProps(
  overrides: Partial<RatingRowProps> = {},
): RatingRowProps {
  return { row: buildRatingRowView(), ...overrides };
}
