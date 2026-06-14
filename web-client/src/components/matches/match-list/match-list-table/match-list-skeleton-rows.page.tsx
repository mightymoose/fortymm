import { render, screen, type Container } from "@/test/utilities";

import { MatchListSkeletonRows } from "./match-list-skeleton-rows";
import { buildMatchListSkeletonRowsProps } from "./match-list-skeleton-rows.factory";
import { matchListTableHeadPage } from "./match-list-table-head.page";

const scoped = (container: Container) => ({
  /** The skeleton `<table>`. Carries `aria-busy="true"` while the first page
   * loads. Always present. */
  getTable() {
    return container.getByRole("table");
  },
  queryTable() {
    return container.queryByRole("table");
  },
  // Spread the table head's queries so the static column headers are reachable
  // through this page object.
  ...matchListTableHeadPage.within(container),
});

/**
 * Test page-object for `MatchListSkeletonRows` — the six-row shimmer
 * placeholder rendered while the first page of matches loads. The skeleton
 * table carries `aria-busy="true"`. No router harness; tests are synchronous.
 */
export const matchListSkeletonRowsPage = {
  render(overrides: Record<string, never> = {}) {
    buildMatchListSkeletonRowsProps(overrides);
    render(<MatchListSkeletonRows />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread this
   * to expose the same queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
