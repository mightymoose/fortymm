import { ErrorBoundary } from "react-error-boundary";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { breadcrumbDisplayPage } from "./breadcrumb/breadcrumb-fetcher/breadcrumb-display.page";
import { Breadcrumb, type BreadcrumbProps } from "./breadcrumb";
import { buildBreadcrumbProps } from "./breadcrumb.factory";

const scoped = (container: Container) => ({
  /** The fallback rendered by the *ancestor* error boundary. `Breadcrumb`
   * owns no boundary of its own — a failed query is meant to propagate
   * upward — so this models the boundary the match-details page supplies in
   * production. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The crumb `BreadcrumbDisplay` renders — both while the Suspense
   * fallback is showing (the plain, tournament-less crumb) and once the
   * query resolves. */
  ...breadcrumbDisplayPage.within(container),
});

/**
 * Test page-object for the public `Breadcrumb` wrapper. `Breadcrumb` adds
 * only a `<Suspense>` boundary around `BreadcrumbFetcher` — its fallback is
 * the plain crumb, so there's no visible loading state to distinguish —  and
 * forwards `matchId` through. It deliberately has *no* error boundary,
 * delegating failures upward; this renders it beneath an `ErrorBoundary`
 * standing in for that ancestor, and stubs the same `GET
 * /v1/matches/:matchId` endpoint the query reads.
 */
export const breadcrumbPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the ancestor boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<BreadcrumbProps> = {}) {
    const props = buildBreadcrumbProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <ErrorBoundary
          fallbackRender={() => <div role="alert">Couldn’t load</div>}
        >
          <Breadcrumb {...props} />
        </ErrorBoundary>
      ),
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
   * `within(node)` subtree. A page object that embeds a `Breadcrumb` (e.g.
   * the match-details page) spreads this to expose the same queries as its
   * own.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
