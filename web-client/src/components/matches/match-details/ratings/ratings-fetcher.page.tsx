import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { ratingsDisplayPage } from "./ratings-fetcher/ratings-display.page";
import { RatingsFetcher, type RatingsProps } from "./ratings-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("ratings-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The card `RatingsDisplay` renders once data arrives — absent (with no
   * error) when the projection is null and the fetcher renders nothing. */
  ...ratingsDisplayPage.within(container),
});

/**
 * Test page-object for `RatingsFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `Ratings` wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — so tests can assert the
 * fetch→`RatingsDisplay` handoff, the render-nothing branch for a null
 * projection, and that a failed query reaches the boundary. Stubs the same
 * `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const ratingsFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
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
        <Suspense fallback={<div data-testid="ratings-loading">Loading…</div>}>
          <RatingsFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    );
  },

  ...scoped(screen),
};
