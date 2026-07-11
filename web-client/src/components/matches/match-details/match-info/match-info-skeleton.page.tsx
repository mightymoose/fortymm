import { render, screen, type Container } from "@/test/utilities";

import { cardChrome } from "./match-info-fetcher/match-info-display.page";
import { MatchInfoSkeleton } from "./match-info-skeleton";

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole("status", { name: /loading match info/i });
  },
  /** The shared design-system card the skeleton wears. Rendered with
   * `Card asChild`, so the status `<section>` *is* the card element. */
  queryCard() {
    return this.getStatus().closest('[data-slot="card"]');
  },
  /** The skeleton's card chrome, in the same shape the loaded panel's page
   * object reports — see {@link cardChrome}. */
  getCardChrome() {
    return cardChrome(this.getStatus());
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
