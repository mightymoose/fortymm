import { render, screen, type Container } from "@/test/utilities";

import { PlayersPanelSkeleton } from "./players-panel-skeleton";

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole("status", { name: /loading the players panel/i });
  },
  /** The shared design-system Card chrome the loaded panel also wears — the
   * status region is itself the card (`Card asChild`). */
  queryCard() {
    return this.getStatus().closest('[data-slot="card"]');
  },
  /** The two-profile grid the loaded panel reuses; reserved so the card keeps
   * its height before the profiles arrive. */
  queryPlayersGrid() {
    return this.getStatus().querySelector(".md-players");
  },
});

/**
 * Test page-object for `PlayersPanelSkeleton` — the `<Suspense>` fallback for
 * the players panel. The component is propless, so `render` takes nothing.
 */
export const playersPanelSkeletonPage = {
  render() {
    render(<PlayersPanelSkeleton />);
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
