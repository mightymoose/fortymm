import { render, screen, type Container } from "@/test/utilities";

import { FilterRow, type FilterRowProps } from "./filter-row";
import { buildFilterRowProps } from "./filter-row.factory";

const scoped = (container: Container) => ({
  /** The "Search players…" text input mirroring the URL's `q`. */
  getSearchInput() {
    return container.getByPlaceholderText(/search players/i);
  },
  /** The clear (X) button — present only when `q` is non-empty. */
  getClearSearchButton() {
    return container.getByRole("button", { name: /clear search/i });
  },
  queryClearSearchButton() {
    return container.queryByRole("button", { name: /clear search/i });
  },
  /** A status tab by its accessible name, e.g. /up next/i, "Live". */
  getTab(name: RegExp | string) {
    return container.getByRole("tab", { name });
  },
  queryTab(name: RegExp | string) {
    return container.queryByRole("tab", { name });
  },
});

/**
 * Test page-object for `FilterRow` — the search input + status tab strip. No
 * router harness: the Tabs render no `<Link>`, so tests can read synchronously
 * after `render`.
 */
export const filterRowPage = {
  render(overrides: Partial<FilterRowProps> = {}) {
    const props = buildFilterRowProps(overrides);
    render(<FilterRow {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed the filter row spread this
   * to expose the same queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
