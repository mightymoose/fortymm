import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { disputeNoticeDisplayPage } from "./dispute-notice-fetcher/dispute-notice-display.page";
import {
  DisputeNoticeFetcher,
  type DisputeNoticeProps,
} from "./dispute-notice-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  ...disputeNoticeDisplayPage.within(container),
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("dispute-notice-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
});

/**
 * Test page-object for `DisputeNoticeFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `DisputeNotice` wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — so tests can assert the fetch →
 * display handoff, the null-projection bail, and that a failed query reaches
 * the boundary. Stubs the same `GET /v1/matches/:matchId` endpoint the query
 * reads.
 */
export const disputeNoticeFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<DisputeNoticeProps> = {}) {
    const props: DisputeNoticeProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the dispute notice</div>
        )}
      >
        <Suspense
          fallback={<div data-testid="dispute-notice-loading">Loading…</div>}
        >
          <DisputeNoticeFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    );
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
