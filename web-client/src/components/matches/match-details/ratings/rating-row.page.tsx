import { render, screen, within, type Container } from "@/test/utilities";

import { sparklinePage } from "../players-panel/sparkline.page";
import { RatingRow, type RatingRowProps } from "./rating-row";
import { buildRatingRowProps } from "./rating-row.factory";

const scoped = (container: Container) => {
  const getRow = (username: string) =>
    container
      .getByText(username, { selector: ".md-rating-row__name" })
      .closest(".md-rating-row") as HTMLElement;

  return {
    /** The whole row for `username` — rows are told apart by player name,
     * same as a reader scans them. */
    getRow,
    queryRow(username: string) {
      return (
        (container
          .queryByText(username, { selector: ".md-rating-row__name" })
          ?.closest(".md-rating-row") as HTMLElement | undefined) ?? null
      );
    },
    /** That row's initials avatar — its class carries the win/loss tone. */
    getAvatar(username: string) {
      return getRow(username).querySelector(".md-avatar")!;
    },
    /** The before→after numbers line, or the "Unrated player" stand-in. */
    getNumbers(username: string) {
      return getRow(username).querySelector(".md-rating-row__numbers")!;
    },
    /** The pre-match number; absent when the player entered unrated (or for
     * an unrated row, where the same class carries "Unrated player"). */
    queryFrom(username: string) {
      return getRow(username).querySelector(".from");
    },
    /** The post-match number; absent for an unrated row. */
    queryTo(username: string) {
      return getRow(username).querySelector(".to");
    },
    /** The signed delta figure; absent when the row has no rating change. */
    queryDelta(username: string) {
      return getRow(username).querySelector(".md-rating-row__delta-num");
    },
    /** The row's trend-sparkline queries, scoped to just that row. */
    sparkline(username: string) {
      return sparklinePage.within(within(getRow(username)) as Container);
    },
  };
};

/**
 * Test page-object for `RatingRow` — one side's line in the rating-change
 * card. Accessors take the row's username, since that's how the rows differ.
 */
export const ratingRowPage = {
  render(overrides: Partial<RatingRowProps> = {}) {
    const props = buildRatingRowProps(overrides);
    render(<RatingRow {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread
   * this to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
