import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { Ratings, type RatingsProps } from "./ratings";
import { ratingsDisplayPage } from "./ratings/ratings-fetcher/ratings-display.page";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** `Ratings`'s own `<Suspense>` fallback while the query is pending. */
  queryLoading() {
    return container.queryByText("Loading...");
  },
  /**
   * The fallback rendered by the *ancestor* error boundary. `Ratings`
   * owns no boundary of its own — a failed query is meant to propagate
   * upward — so this models the boundary the match-details page supplies in
   * production.
   */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The card the fetcher renders once data arrives — absent (with no error)
   * when the match has no visible rating change. */
  ...ratingsDisplayPage.within(container),
});

/**
 * Test page-object for the public `Ratings` wrapper. `Ratings` adds only a
 * `<Suspense>` boundary (with its real `Loading...` fallback) around
 * `RatingsFetcher` and forwards `matchId` through — it deliberately has *no*
 * error boundary, delegating failures upward. This renders it beneath an
 * `ErrorBoundary` standing in for that ancestor so a rejected query can be
 * observed reaching the boundary, and stubs the same
 * `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const ratingsPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the ancestor boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<RatingsProps> = {}) {
    const props: RatingsProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the rating change</div>
        )}
      >
        <Ratings {...props} />
      </ErrorBoundary>,
    );
  },

  /**
   * Scope the card accessors to a container — the whole `screen` (default)
   * or a `within(node)` subtree. A page object that embeds a `Ratings`
   * (e.g. the match-details page) calls this to expose the same queries as
   * its own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
