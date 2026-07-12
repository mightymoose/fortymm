import type { RatingRowProps } from "./rating-row";
import type {
  RatingRowEstablishedView,
  RatingRowMovedView,
  RatingRowView,
} from "../ratings-query";

/** A +12 move from 1612 to 1624 with a rising four-point trend line — a player
 * who was **already rated**. */
export function buildRatingRowChangeView(
  overrides: Partial<RatingRowMovedView> = {},
): RatingRowMovedView {
  return {
    kind: "moved",
    from: 1612,
    to: 1624,
    deltaLabel: "+12",
    deltaAriaLabel: "Gained 12 rating",
    deltaUp: true,
    sparkline: [1580, 1601, 1612, 1624],
    ...overrides,
  };
}

/**
 * A player whose **first rated match** this was: `Unrated → 1268`.
 *
 * There is no `deltaLabel` and no `sparkline` to override — the type has no such
 * fields, which is the point: this fixture cannot be made to render a chip
 * (#952).
 */
export function buildEstablishedRatingRowChangeView(
  overrides: Partial<RatingRowEstablishedView> = {},
): RatingRowEstablishedView {
  return {
    kind: "established",
    to: 1268,
    ariaLabel: "Unrated before this match, now rated 1268",
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
