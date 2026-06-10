import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { gameGridPage } from "./game-grid.page";
import { headingPage } from "./heading.page";
import { heroRowPage } from "./hero-row.page";
import { ScoreboardFetcher, type ScoreboardProps } from "./scoreboard-fetcher";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the match-details query is pending. */
  queryLoading() {
    return container.queryByTestId("scoreboard-loading");
  },
  /** The error-boundary fallback shown when the query rejects. */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The `<section>` landmark `ScoreboardDisplay` renders once data arrives. */
  getRegion() {
    return container.getByRole("region");
  },
  /** The `<h2>` `ScoreboardDisplay` labels the region with. */
  getHeading() {
    return container.getByRole("heading", { level: 2 });
  },
  /** The heading strip (status chip + format/race labels) the display renders. */
  headingStrip: headingPage.within(container),
  /** The hero row (left player / score block / right player) the display renders. */
  heroRow: heroRowPage.within(container),
  /** The per-game score grid the display renders at the bottom of the hero. */
  gameGrid: gameGridPage.within(container),
});

/**
 * Test page-object for `ScoreboardFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `Scoreboard` wrapper — a
 * `<Suspense>` plus an `ErrorBoundary` — so tests can assert the
 * fetch→`ScoreboardDisplay` handoff and that a failed query reaches the
 * boundary. Stubs the same `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const scoreboardFetcherPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the error boundary.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  render(overrides: Partial<ScoreboardProps> = {}) {
    const props: ScoreboardProps = {
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load the scoreboard</div>}
      >
        <Suspense fallback={<div data-testid="scoreboard-loading">Loading…</div>}>
          <ScoreboardFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    );
  },

  ...scoped(screen),
};
