import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import {
  CallStatusBannerFetcher,
  type CallStatusBannerProps,
} from "./call-status-banner-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("call-status-banner-loading");
  },
  /** The fallback rendered by the *ancestor* error boundary — the fetcher
   * owns no boundary of its own. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The banner `CallStatusBannerDisplay` renders once data arrives. Scoped
   * to the display's own (no-router) queries — this page object never
   * exercises the tournament-owner link case, which is covered by
   * `call-status-banner-display.test.tsx` under its own router harness. */
  queryBanner(name?: string | RegExp) {
    return container.queryByRole("alert", name ? { name } : undefined);
  },
  getBanner(name?: string | RegExp) {
    return container.getByRole("alert", name ? { name } : undefined);
  },
});

/**
 * Test page-object for `CallStatusBannerFetcher`. Mirrors the real
 * `CallStatusBanner` wrapper — a `<Suspense>` plus an `ErrorBoundary` — and
 * stubs the same `GET /v1/matches/:matchId` endpoint the query reads. No
 * router harness: the scenarios exercised here never resolve to the
 * tournament-owner link (that's covered at the display layer).
 */
export const callStatusBannerFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<CallStatusBannerProps> = {}) {
    const props: CallStatusBannerProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the match status</div>
        )}
      >
        <Suspense
          fallback={
            <div data-testid="call-status-banner-loading">Loading…</div>
          }
        >
          <CallStatusBannerFetcher {...props} />
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
