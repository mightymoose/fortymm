import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import {
  mockMatchResultsEndpoint,
  type MatchResultsResolver,
} from "@/mocks/endpoints/matches/match-results.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { FinalizeCallout, type FinalizeCalloutProps } from "./finalize-callout";
import { finalizeCalloutDisplayPage } from "./finalize-callout/finalize-callout-fetcher/finalize-callout-active/finalize-callout-display.page";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** `FinalizeCallout`'s own `<Suspense>` fallback while the query is pending. */
  queryLoading() {
    return container.queryByText("Loading...");
  },
  /**
   * The fallback rendered by the *ancestor* error boundary. `FinalizeCallout`
   * owns no boundary of its own — a failed query is meant to propagate upward —
   * so this models the boundary the match-details page supplies in production.
   */
  queryBoundaryError() {
    return container.queryByRole("alert");
  },
  ...finalizeCalloutDisplayPage.within(container),
});

/**
 * Test page-object for the public `FinalizeCallout` wrapper. The wrapper adds
 * only a `<Suspense>` boundary (with its real `Loading...` fallback) around
 * `FinalizeCalloutFetcher` and forwards `matchId` through — it deliberately
 * has *no* error boundary, delegating failures upward. This renders it beneath
 * an `ErrorBoundary` standing in for that ancestor, and stubs the
 * `GET /v1/matches/:matchId` endpoint the query reads (plus, on demand, the
 * `POST .../results` endpoint the embedded mutation hits).
 */
export const finalizeCalloutPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the ancestor boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /** Stub `POST /v1/matches/:matchId/results` for tests that click Post. */
  mockResultsEndpoint(resolver: MatchResultsResolver) {
    mockMatchResultsEndpoint(server, resolver);
  },

  render(overrides: Partial<FinalizeCalloutProps> = {}) {
    const props: FinalizeCalloutProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the finalize callout</div>
        )}
      >
        <FinalizeCallout {...props} />
      </ErrorBoundary>,
    );
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. A page object that embeds a `FinalizeCallout`
   * (e.g. the match-details page) calls this to expose the same callout
   * queries as its own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
