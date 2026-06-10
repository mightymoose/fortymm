import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { matchInfoDisplayPage } from "./match-info-display.page";
import { MatchInfoFetcher, type MatchInfoProps } from "./match-info-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("match-info-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The card `MatchInfoDisplay` renders once data arrives. */
  ...matchInfoDisplayPage.within(container),
});

/**
 * Test page-object for `MatchInfoFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `MatchInfo` wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — so tests can assert the
 * fetch→`MatchInfoDisplay` handoff and that a failed query reaches the
 * boundary. Stubs the same `GET /v1/matches/:matchId` endpoint the query
 * reads.
 */
export const matchInfoFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<MatchInfoProps> = {}) {
    const props: MatchInfoProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the match info</div>
        )}
      >
        <Suspense
          fallback={<div data-testid="match-info-loading">Loading…</div>}
        >
          <MatchInfoFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    );
  },

  ...scoped(screen),
};
