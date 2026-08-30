import { Suspense } from "react";
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

import { breadcrumbDisplayPage } from "./breadcrumb-fetcher/breadcrumb-display.page";
import {
  BreadcrumbFetcher,
  type BreadcrumbFetcherProps,
} from "./breadcrumb-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("breadcrumb-loading");
  },
  /** The fallback rendered by the *ancestor* error boundary — the fetcher
   * owns no boundary of its own. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The crumb `BreadcrumbDisplay` renders once data arrives. */
  ...breadcrumbDisplayPage.within(container),
});

/**
 * Test page-object for `BreadcrumbFetcher`. The fetcher reads via
 * `useSuspenseQuery` and the display renders typed `<Link>`s, so this mirrors
 * the real `Breadcrumb` wrapper — a `<Suspense>` plus an `ErrorBoundary` —
 * and mounts it under a minimal router that registers both crumb targets.
 * Stubs the same `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const breadcrumbFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<BreadcrumbFetcherProps> = {}) {
    const props: BreadcrumbFetcherProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <ErrorBoundary
          fallbackRender={() => <div role="alert">Couldn’t load</div>}
        >
          <Suspense
            fallback={<div data-testid="breadcrumb-loading">Loading…</div>}
          >
            <BreadcrumbFetcher {...props} />
          </Suspense>
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
   * `within(node)` subtree.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
