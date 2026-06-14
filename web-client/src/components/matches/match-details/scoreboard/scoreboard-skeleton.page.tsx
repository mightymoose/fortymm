import { render, screen, type Container } from "@/test/utilities";

import { ScoreboardSkeleton } from "./scoreboard-skeleton";

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole("status", { name: /loading match scoreboard/i });
  },
  /** The heading-strip region the loaded scoreboard reuses; reserved so the
   * strip doesn't collapse before the chip/format labels arrive. */
  queryHeadingStrip() {
    return this.getStatus().querySelector(".md-hero__strip");
  },
  /** The hero-row region (players + score) the loaded scoreboard reuses. */
  queryHeroRow() {
    return this.getStatus().querySelector(".md-hero__row");
  },
  /** The per-game grid region the loaded scoreboard reuses. */
  queryGameGrid() {
    return this.getStatus().querySelector(".md-games");
  },
});

/**
 * Test page-object for `ScoreboardSkeleton` — the `<Suspense>` fallback for the
 * scoreboard. The component is propless, so `render` takes nothing.
 */
export const scoreboardSkeletonPage = {
  render() {
    render(<ScoreboardSkeleton />);
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
