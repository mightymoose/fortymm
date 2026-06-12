import { render, screen, type Container } from "@/test/utilities";

import { ratingRowPage } from "./ratings-display/rating-row.page";
import { RatingsDisplay, type RatingsDisplayProps } from "./ratings-display";
import { buildRatingsDisplayProps } from "./ratings-display.factory";

const scoped = (container: Container) => {
  const getCard = () =>
    container.getByRole("region", { name: "Result · rating change" });

  return {
    /** The card's `<section>` landmark, named by its visible heading. */
    getCard,
    queryCard() {
      return container.queryByRole("region", {
        name: "Result · rating change",
      });
    },
    /** The visible card heading. */
    getTitle() {
      return container.getByRole("heading", {
        level: 3,
        name: "Result · rating change",
      });
    },
    /** The hairline dividers between rows — one fewer than the row count. */
    getDividers() {
      return Array.from(getCard().querySelectorAll(".md-rating-divider"));
    },
    // Row lookups (`getRow(username)`, `queryDelta(username)`, …) come from
    // the row's own page object.
    ...ratingRowPage.within(container),
  };
};

/**
 * Test page-object for `RatingsDisplay` — the pure view-in, DOM-out
 * rating-change card. Use the row accessors with a username to assert
 * within one side's line.
 */
export const ratingsDisplayPage = {
  render(overrides: Partial<RatingsDisplayProps> = {}) {
    const props = buildRatingsDisplayProps(overrides);
    render(<RatingsDisplay {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The fetcher and wrapper page objects spread this
   * to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
