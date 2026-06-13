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

import { scoreCtaDisplayPage } from "./score-cta-fetcher/score-cta-display.page";
import { ScoreCtaFetcher, type ScoreCtaProps } from "./score-cta-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("score-cta-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The "Score" link the display renders once a scorable view arrives. */
  ...scoreCtaDisplayPage.within(container),
  /** Absence-friendly variant of the display's link query. */
  queryScoreLink() {
    return container.queryByRole("link", { name: "Score" });
  },
});

/**
 * Test page-object for `ScoreCtaFetcher`. The fetcher reads via
 * `useSuspenseQuery` and the display renders a typed `<Link>`, so this mirrors
 * the real `ScoreCta` wrapper — a `<Suspense>` plus an `ErrorBoundary` — and
 * mounts it under a minimal router that registers the score-entry route the
 * link targets. Tests can assert the fetch → display handoff, the
 * null-projection bail, and that a failed query reaches the boundary. Stubs
 * the same `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const scoreCtaFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<ScoreCtaProps> = {}) {
    const props: ScoreCtaProps = {
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
            <div role="alert">Couldn’t load the score CTA</div>
          )}
        >
          <Suspense
            fallback={<div data-testid="score-cta-loading">Loading…</div>}
          >
            <ScoreCtaFetcher {...props} />
          </Suspense>
        </ErrorBoundary>
      ),
    });
    // Route stub the "Score" link navigates to — registered so the typed
    // <Link> resolves at render time.
    const scoringNew = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/games/$gameNumber/scores/new",
      component: () => <div>scoring-new</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, scoringNew]),
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
