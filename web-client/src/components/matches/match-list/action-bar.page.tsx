import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import { ActionBar, type ActionBarProps } from "./action-bar";
import { buildActionBarProps } from "./action-bar.factory";

const scoped = (container: Container) => ({
  /** The "Export CSV" download link, pointed at the current filters' CSV. */
  getExportLink() {
    return container.getByRole("link", { name: /export csv/i });
  },
  queryExportLink() {
    return container.queryByRole("link", { name: /export csv/i });
  },
  /** The "+ New match" link to the match-create route. */
  getNewMatchLink() {
    return container.getByRole("link", { name: /new match/i });
  },
  queryNewMatchLink() {
    return container.queryByRole("link", { name: /new match/i });
  },
  /** The LIVE pill showing the live-match count, e.g. "3 LIVE". */
  getLivePill(liveCount: number) {
    return container.getByText((_: string, node: Element | null) => {
      return node?.textContent === `${liveCount} LIVE`;
    });
  },
});

/**
 * Test page-object for `ActionBar` — the page header strip (title, crumb, LIVE
 * pill, Export CSV + New match links). It renders a typed `<Link to="/matches/new">`,
 * so `render` mounts it under a minimal memory router that registers that route.
 * The router resolves asynchronously, so tests start with
 * `await actionBarPage.find...()`.
 */
export const actionBarPage = {
  render(overrides: Partial<ActionBarProps> = {}) {
    const props = buildActionBarProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ActionBar {...props} />,
    });
    // Route stub the "+ New match" link navigates to — registered so the typed
    // <Link> resolves at render time.
    const newMatchRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/new",
      component: () => <div>new-match</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, newMatchRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  },

  /**
   * The async-first accessor — the router resolves the route tree on the first
   * paint, so tests await this before reading the synchronous accessors.
   */
  findNewMatchLink() {
    return screen.findByRole("link", { name: /new match/i });
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed the action bar spread this
   * to expose the same queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
