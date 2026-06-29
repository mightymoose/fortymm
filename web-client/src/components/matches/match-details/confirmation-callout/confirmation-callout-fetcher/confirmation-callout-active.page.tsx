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
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import {
  ConfirmationCalloutActive,
  type ConfirmationCalloutActiveProps,
} from "./confirmation-callout-active";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-active/confirmation-callout-display.page";
import {
  buildAwaitingConfirmationView,
  buildReviewConfirmationView,
} from "./confirmation-callout-active/confirmation-callout-display.factory";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  // The active layer adds no DOM of its own — expose the display's queries.
  ...confirmationCalloutDisplayPage.within(container),
});

/**
 * Test page-object for `ConfirmationCalloutActive` — the layer that owns the
 * accept mutation. The display below it renders correction `<Link>`s, so the
 * component mounts under a minimal memory router that registers the correction
 * route. Tests stub
 * `POST /v1/matches/:matchId/results/:resultId/acceptance` and drive the CTA;
 * no GET stub is needed because the mutation's cache invalidation only
 * refetches *mounted* queries, and this harness mounts none.
 */
export const confirmationCalloutActivePage = {
  /** Stub `POST /v1/matches/:matchId/results/:resultId/acceptance`. */
  mockAcceptanceEndpoint(resolver: MatchAcceptanceResolver) {
    mockMatchAcceptanceEndpoint(server, resolver);
  },

  /** The submitter's passive awaiting view. */
  awaitingView: buildAwaitingConfirmationView,

  render(overrides: Partial<ConfirmationCalloutActiveProps> = {}) {
    const props: ConfirmationCalloutActiveProps = {
      view: buildReviewConfirmationView(),
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ConfirmationCalloutActive {...props} />,
    });
    const correctRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/correct",
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
   * `within(node)` subtree.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
