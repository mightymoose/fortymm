import { render, screen, type Container } from "@/test/utilities";

import { Heading, type HeadingProps } from "./heading";
import { buildHeadingProps } from "./heading.factory";
import { statusChipPage } from "./status-chip.page";

const scoped = (container: Container) => ({
  /** The status chip on the left of the strip; absent when `chip` is null. */
  ...statusChipPage.within(container),
  /** The "SINGLES · BO5"-style format label on the right of the strip. */
  getFormatLabel() {
    return container.getByTestId("scoreboard-heading-format");
  },
  /** The "First to N" race label; absent when `raceLabel` is null. */
  queryRaceLabel() {
    return container.queryByTestId("scoreboard-heading-race");
  },
  getRaceLabel() {
    return container.getByTestId("scoreboard-heading-race");
  },
});

/**
 * Test page-object for the `Heading` strip — the status chip plus the
 * format/race meta labels along the top of the scoreboard.
 */
export const headingPage = {
  render(overrides: Partial<HeadingProps> = {}) {
    const props = buildHeadingProps(overrides);
    render(<Heading {...props} />);
  },

  /**
   * Scope the heading accessors to a container — the whole `screen` (default)
   * or a `within(node)` subtree. Page objects that embed the heading (the
   * scoreboard display, fetcher, and wrapper) call this to expose the same
   * chip/label queries as their own `.heading`, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
