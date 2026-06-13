import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { sessionResponse } from "@/test/factories";
import { render, screen, type Container } from "@/test/utilities";

import { saveYourMatchDisplayPage } from "./save-your-match-fetcher/save-your-match-display.page";
import {
  SaveYourMatchFetcher,
  type SaveYourMatchProps,
} from "./save-your-match-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("save-your-match-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The display's queries (prompt, receipt, CTA) once a view arrives. */
  ...saveYourMatchDisplayPage.within(container),
});

/**
 * Test page-object for `SaveYourMatchFetcher`. The fetcher reads via
 * `useSuspenseQuery` and hands the view to the display, which itself reads
 * `useSession()` and renders `<Link>`s, so this mirrors the real wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — mounted under a minimal router that
 * registers the settings route the display links to. Tests can assert the
 * fetch → display handoff, the null-projection bail, and that a failed query
 * reaches the boundary. Stubs the same `GET /v1/matches/:matchId` the query
 * reads and `GET /v1/session` the display reads.
 */
export const saveYourMatchFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /** Stub `GET /v1/session` — defaults to a guest so the display renders. */
  mockSession(overrides: Parameters<typeof sessionResponse>[0] = {}) {
    server.use(
      http.get("*/v1/session", () =>
        HttpResponse.json(sessionResponse(overrides)),
      ),
    );
  },

  render(overrides: Partial<SaveYourMatchProps> = {}) {
    const props: SaveYourMatchProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <ErrorBoundary
          fallbackRender={() => (
            <div role="alert">Couldn’t load the save prompt</div>
          )}
        >
          <Suspense
            fallback={
              <div data-testid="save-your-match-loading">Loading…</div>
            }
          >
            <SaveYourMatchFetcher {...props} />
          </Suspense>
        </ErrorBoundary>
      ),
    });
    // Route stub the display's "Save this match" / "Save it" links target.
    const settings = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings",
      component: () => <div>settings-page</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, settings]),
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
