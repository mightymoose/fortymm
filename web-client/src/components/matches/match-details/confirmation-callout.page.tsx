import { ErrorBoundary } from "react-error-boundary";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  mockMatchAcceptanceEndpoint,
  type MatchAcceptanceResolver,
} from "@/mocks/endpoints/matches/match-acceptance.endpoint";
import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import {
  ConfirmationCallout,
  type ConfirmationCalloutProps,
} from "./confirmation-callout";
import { confirmationCalloutDisplayPage } from "./confirmation-callout/confirmation-callout-fetcher/confirmation-callout-active/confirmation-callout-display.page";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** `ConfirmationCallout`'s own `<Suspense>` fallback while the query is
   * pending — a visually-hidden `role="status"` (the callout reserves no
   * skeleton, since it usually resolves to nothing). Scoped by accessible name
   * so it stays unambiguous when composed alongside the other sections. */
  queryLoading() {
    return container.queryByRole("status", {
      name: /loading the result acceptance prompt/i,
    });
  },
  /**
   * The fallback rendered by the *ancestor* error boundary.
   * `ConfirmationCallout` owns no boundary of its own — a failed query is
   * meant to propagate upward — so this models the boundary the match-details
   * page supplies in production.
   */
  queryBoundaryError() {
    return container.queryByRole("alert");
  },
  ...confirmationCalloutDisplayPage.within(container),
});

/**
 * Test page-object for the public `ConfirmationCallout` wrapper. The wrapper
 * adds only a `<Suspense>` boundary (with its real visually-hidden
 * `role="status"` fallback) around `ConfirmationCalloutFetcher` and forwards
 * `matchId` through — it
 * deliberately has *no* error boundary, delegating failures upward. This
 * renders it beneath an `ErrorBoundary` standing in for that ancestor, and
 * stubs the `GET /v1/matches/:matchId` endpoint the query reads (plus, on
 * demand, the acceptance POST endpoint the embedded mutation hits).
 */
export const confirmationCalloutPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the ancestor boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /** Stub `POST /v1/matches/:matchId/results/:resultId/acceptance` for tests
   * that accept. */
  mockAcceptanceEndpoint(resolver: MatchAcceptanceResolver) {
    mockMatchAcceptanceEndpoint(server, resolver);
  },

  render(overrides: Partial<ConfirmationCalloutProps> = {}) {
    const props: ConfirmationCalloutProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    // The display renders correction `<Link>`s, so mount the wrapper under a
    // memory router that registers the correction route.
    const tree = (
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the confirmation callout</div>
        )}
      >
        <ConfirmationCallout {...props} />
      </ErrorBoundary>
    );
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => tree,
    });
    const correctRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/results/new",
      component: () => <div>correction-route</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, correctRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    render(<RouterProvider router={router} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. A page object that embeds a `ConfirmationCallout`
   * (e.g. the match-details page) calls this to expose the same callout
   * queries as its own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
