import { render, screen, type Container } from "@/test/utilities";

import { MatchInfoSkeleton } from "./match-info-skeleton";

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole("status", { name: /loading match info/i });
  },
  /** The card chrome the loaded card reuses (the status region is itself the
   * `.md-card`). */
  queryCard() {
    return this.getStatus().closest(".md-card");
  },
  /** The label/value rows reserved so the card keeps its height before the
   * real rows arrive. */
  queryInfoRows() {
    return this.getStatus().querySelectorAll(".md-info-row");
  },
});

/**
 * Test page-object for `MatchInfoSkeleton` — the `<Suspense>` fallback for the
 * match-info card. The component is propless, so `render` takes nothing.
 */
export const matchInfoSkeletonPage = {
  render() {
    render(<MatchInfoSkeleton />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree, so a parent page object can reuse these queries.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
