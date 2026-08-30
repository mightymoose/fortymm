import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import {
  BreadcrumbDisplay,
  type BreadcrumbDisplayProps,
} from "./breadcrumb-display";
import { buildBreadcrumbDisplayProps } from "./breadcrumb-display.factory";

const scoped = (container: Container) => ({
  /** The current-match label (e.g. "Match abcdef"). Always present once the
   * router resolves. */
  findCurrent(text: string | RegExp) {
    return container.findByText(text);
  },
  /** The "Matches" parent link. */
  queryMatchesLink() {
    return container.queryByRole("link", { name: /^matches$/i });
  },
  /** The tournament crumb link, named by the tournament's name — absent
   * entirely for a casual match. */
  queryTournamentLink(name: string | RegExp) {
    return container.queryByRole("link", { name });
  },
  findTournamentLink(name: string | RegExp) {
    return container.findByRole("link", { name });
  },
});

/**
 * Test page-object for `BreadcrumbDisplay`. The in-app crumb (and the
 * tournament crumb, when present) renders a typed `<Link>`, so `render`
 * mounts the component under a minimal memory router that registers both
 * routes. The router resolves asynchronously, so tests start with
 * `await breadcrumbDisplayPage.findCurrent(...)`.
 */
export const breadcrumbDisplayPage = {
  render(overrides: Partial<BreadcrumbDisplayProps> = {}) {
    const props = buildBreadcrumbDisplayProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <BreadcrumbDisplay {...props} />,
    });
    // Route stubs the crumb links navigate to — registered so the typed
    // <Link>s resolve at render time.
    const matchesList = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches",
      component: () => <div>matches-list</div>,
    });
    const tournamentDetail = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tournaments/$tournamentId",
      component: () => <div>tournament-detail</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        indexRoute,
        matchesList,
        tournamentDetail,
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
