import { render, screen, type Container } from "@/test/utilities";

import { infoRowPage } from "./match-info-display/info-row.page";
import {
  MatchInfoDisplay,
  type MatchInfoDisplayProps,
} from "./match-info-display";
import { buildMatchInfoDisplayProps } from "./match-info-display.factory";

const scoped = (container: Container) => ({
  /** The card's `<section>` landmark, named by its visible heading. */
  getCard() {
    return container.getByRole("region", { name: "Match info" });
  },
  queryCard() {
    return container.queryByRole("region", { name: "Match info" });
  },
  /** The visible card heading. */
  getTitle() {
    return container.getByRole("heading", { level: 3, name: "Match info" });
  },
  // Row lookups (`getLabel(label)` / `getValue(label)`) come from the row's
  // own page object.
  ...infoRowPage.within(container),
});

/**
 * Test page-object for `MatchInfoDisplay` — the pure view-in, DOM-out
 * sidebar card. Use `getValue(label)` to assert a row's value.
 */
export const matchInfoDisplayPage = {
  render(overrides: Partial<MatchInfoDisplayProps> = {}) {
    const props = buildMatchInfoDisplayProps(overrides);
    render(<MatchInfoDisplay {...props} />);
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
