import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { playersPanelDisplayPage } from "./players-panel-fetcher/players-panel-display.page";
import {
  PlayersPanelFetcher,
  type PlayersPanelProps,
} from "./players-panel-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("players-panel-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The panel `PlayersPanelDisplay` renders once data arrives. */
  ...playersPanelDisplayPage.within(container),
});

/**
 * Test page-object for `PlayersPanelFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `PlayersPanel` wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — so tests can assert the
 * fetch→`PlayersPanelDisplay` handoff and that a failed query reaches the
 * boundary. Stubs the same `GET /v1/matches/:matchId` endpoint the query
 * reads.
 */
export const playersPanelFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<PlayersPanelProps> = {}) {
    const props: PlayersPanelProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => (
          <div role="alert">Couldn’t load the players panel</div>
        )}
      >
        <Suspense
          fallback={<div data-testid="players-panel-loading">Loading…</div>}
        >
          <PlayersPanelFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    );
  },

  ...scoped(screen),
};
