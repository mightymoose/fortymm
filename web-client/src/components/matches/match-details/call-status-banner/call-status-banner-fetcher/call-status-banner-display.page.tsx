import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import {
  CallStatusBannerDisplay,
  type CallStatusBannerDisplayProps,
} from "./call-status-banner-display";
import { buildCallStatusBannerDisplayProps } from "./call-status-banner-display.factory";

const scoped = (container: Container) => ({
  /** Resolves once the router harness has settled — the router resolves
   * asynchronously (even when the component itself renders synchronously),
   * so every test's first assertion must go through this (or
   * `findTournamentLink`) before `queryBanner`/`getBanner`, including tests
   * asserting the banner's *absence*. */
  findHarness() {
    return container.findByTestId("call-status-banner-harness");
  },
  /** The banner's `role="alert"` region, named by its `AlertTitle`. Absent
   * entirely for `kind: "none"`. */
  queryBanner(name?: string | RegExp) {
    return container.queryByRole("alert", name ? { name } : undefined);
  },
  getBanner(name?: string | RegExp) {
    return container.getByRole("alert", name ? { name } : undefined);
  },
  /** The owner-only "Open the tournament" link (the `awaiting_call` +
   * `canEdit` case — ADR-0015: hidden, not disabled, for a non-owner). */
  queryTournamentLink() {
    return container.queryByRole("link", { name: /open the tournament/i });
  },
  findTournamentLink() {
    return container.findByRole("link", { name: /open the tournament/i });
  },
});

/**
 * Test page-object for `CallStatusBannerDisplay`. The `awaiting_call` +
 * `canEdit` case renders a typed `<Link>` into the tournament, so `render`
 * mounts the component under a minimal memory router that registers that
 * route.
 */
export const callStatusBannerDisplayPage = {
  render(overrides: Partial<CallStatusBannerDisplayProps> = {}) {
    const props = buildCallStatusBannerDisplayProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      // The wrapping div is test-harness-only (see `findHarness`) — it exists
      // to give every case, including `kind: "none"`'s empty render, a stable
      // element to await before asserting on the banner's presence/absence.
      component: () => (
        <div data-testid="call-status-banner-harness">
          <CallStatusBannerDisplay {...props} />
        </div>
      ),
    });
    // Route stub the owner's "Open the tournament" link navigates to —
    // registered so the typed <Link> resolves at render time.
    const tournamentDetail = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tournaments/$tournamentId",
      component: () => <div>tournament-detail</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, tournamentDetail]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. A page object that embeds this component spreads
   * this to expose the same queries as its own.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
