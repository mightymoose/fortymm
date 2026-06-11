import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { headToHeadDisplayPage } from "./head-to-head-display.page";
import {
  HeadToHeadFetcher,
  type HeadToHeadProps,
} from "./head-to-head-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("head-to-head-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The card `HeadToHeadDisplay` renders once data arrives — absent (with no
   * error) when the projection is null and the fetcher renders nothing. */
  ...headToHeadDisplayPage.within(container),
});

/**
 * Test page-object for `HeadToHeadFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `HeadToHead` wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — so tests can assert the
 * fetch→`HeadToHeadDisplay` handoff, the render-nothing branch for a null
 * projection, and that a failed query reaches the boundary. Stubs the same
 * `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const headToHeadFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<HeadToHeadProps> = {}) {
    const props: HeadToHeadProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the head-to-head record</div>
        )}
      >
        <Suspense
          fallback={<div data-testid="head-to-head-loading">Loading…</div>}
        >
          <HeadToHeadFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    );
  },

  ...scoped(screen),
};
