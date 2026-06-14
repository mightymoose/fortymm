import { render, screen, within, type Container } from "@/test/utilities";

import { MatchListTableHead } from "./match-list-table-head";
import { buildMatchListTableHeadProps } from "./match-list-table-head.factory";

const scoped = (container: Container) => ({
  /** The header row (`<tr>`) inside the static `<thead>`. Always present. */
  getHeaderRow() {
    return container.getByRole("row");
  },
  /** A column header (`<th>` with text) by its accessible name, e.g.
   * "Match" / "Players" / "Score" / "Status" / "Started". The trailing empty
   * action `<th>` has no name and is not reachable this way. */
  getColumnHeader(name: string) {
    return within(this.getHeaderRow()).getByRole("columnheader", { name });
  },
  queryColumnHeader(name: string) {
    return within(this.getHeaderRow()).queryByRole("columnheader", { name });
  },
});

/**
 * Test page-object for `MatchListTableHead` — the static column header row.
 * A bare `<thead>` is not a valid standalone DOM tree for a row query, so
 * `render` wraps it in a `<table>`. No router harness; tests are synchronous.
 */
export const matchListTableHeadPage = {
  render(overrides: Parameters<typeof buildMatchListTableHeadProps>[0] = {}) {
    buildMatchListTableHeadProps(overrides);
    render(
      <table>
        <MatchListTableHead />
      </table>,
    );
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
