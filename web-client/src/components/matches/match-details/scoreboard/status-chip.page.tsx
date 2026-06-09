import { render, screen, type Container } from "@/test/utilities";

import { StatusChip, type StatusChipProps } from "./status-chip";
import { buildStatusChipProps } from "./status-chip.factory";

const scoped = (container: Container) => ({
  queryChip() {
    return container.queryByRole("status");
  },
  getChip() {
    return container.getByRole("status");
  },
});

/**
 * Test page-object for `StatusChip` — the Badge announcing the match status
 * on the left of the scoreboard heading strip.
 */
export const statusChipPage = {
  render(overrides: Partial<StatusChipProps> = {}) {
    const props = buildStatusChipProps(overrides);
    render(<StatusChip {...props} />);
  },

  /**
   * Scope the chip accessors to a container — the whole `screen` (default) or
   * a `within(node)` subtree. Page objects that embed the chip (the heading
   * strip and everything above it) call this to expose the same queries,
   * rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
