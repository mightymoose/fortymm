import { render, screen, type Container } from "@/test/utilities";

import { RatingBox, type RatingBoxProps } from "./rating-box";
import { buildRatingBoxProps } from "./rating-box.factory";
import { sparklinePage } from "./sparkline.page";

const scoped = (container: Container) => ({
  /** The rating number, resolved by its value (e.g. "1612"). */
  getRating(value: string) {
    return container.getByText(value, {
      selector: ".md-profile__rating-value",
    });
  },
  /** The dimmed "Unrated" placeholder shown when there's no pre-match
   * rating; absent for a rated player. */
  getUnrated() {
    return container.getByText("Unrated", {
      selector: ".md-profile__rating-value .dim",
    });
  },
  queryUnrated() {
    return container.queryByText("Unrated", {
      selector: ".md-profile__rating-value .dim",
    });
  },
  // The trend svg next to the value; absent without enough history.
  ...sparklinePage.within(container),
});

/**
 * Test page-object for `RatingBox` — the pre-match rating box at the top of a
 * profile: the rounded rating (or "Unrated") plus an optional trend sparkline.
 */
export const ratingBoxPage = {
  render(overrides: Partial<RatingBoxProps> = {}) {
    const props = buildRatingBoxProps(overrides);
    render(<RatingBox {...props} />);
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
