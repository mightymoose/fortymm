import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { confirmationCalloutDisplayPage } from "./confirmation-callout-fetcher/confirmation-callout-active/confirmation-callout-display.page";
import {
  ConfirmationCalloutFetcher,
  type ConfirmationCalloutProps,
} from "./confirmation-callout-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  ...confirmationCalloutDisplayPage.within(container),
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("confirmation-callout-loading");
  },
  /** The error-boundary fallback shown when the query rejects. (Same
   * `role="alert"` query as the display's inline error — overridden here for
   * the boundary semantics; no mutation runs in this harness.) */
  queryError() {
    return container.queryByRole("alert");
  },
});

/**
 * Test page-object for `ConfirmationCalloutFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `ConfirmationCallout` wrapper —
 * a `<Suspense>` plus an `ErrorBoundary` — so tests can assert the fetch →
 * display handoff, the null-projection bail, and that a failed query reaches
 * the boundary. Stubs the same `GET /v1/matches/:matchId` endpoint the query
 * reads. NOTE: the boundary fallback and the display's inline mutation error
 * both use `role="alert"`; in this harness no mutation runs, so `queryError`
 * is unambiguous.
 */
export const confirmationCalloutFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<ConfirmationCalloutProps> = {}) {
    const props: ConfirmationCalloutProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the confirmation callout</div>
        )}
      >
        <Suspense
          fallback={
            <div data-testid="confirmation-callout-loading">Loading…</div>
          }
        >
          <ConfirmationCalloutFetcher {...props} />
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
