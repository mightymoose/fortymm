import { render, screen, type Container } from "@/test/utilities";

import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import { buildStatusBadgeProps } from "./status-badge.factory";

const scoped = (container: Container) => ({
  /** The status pill, located by its visible label text. The `Badge` has no
   * role, so callers pass the label they rendered. */
  getBadge(label: string) {
    return container.getByText(label);
  },
  queryBadge(label: string) {
    return container.queryByText(label);
  },
  /** The pulsing dot inside the pill — present only for the live tone. Scoped
   * to the badge carrying `label`. */
  queryLiveDot(label: string) {
    return this.getBadge(label).querySelector(".live-dot");
  },
});

/**
 * Test page-object for `StatusBadge` — a status pill. No router harness; tests
 * render and query synchronously.
 */
export const statusBadgePage = {
  render(overrides: Partial<StatusBadgeProps> = {}) {
    const props = buildStatusBadgeProps(overrides);
    render(<StatusBadge {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Parent page objects spread this to expose the same
   * queries as their own.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
