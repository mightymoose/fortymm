import { ErrorBoundary } from "react-error-boundary";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import { Scoreboard, type ScoreboardProps } from "./scoreboard";
import { gameGridPage } from "./scoreboard/scoreboard-fetcher/scoreboard-display/game-grid.page";
import { headingPage } from "./scoreboard/scoreboard-fetcher/scoreboard-display/heading.page";
import { heroRowPage } from "./scoreboard/scoreboard-fetcher/scoreboard-display/hero-row.page";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  /** `Scoreboard`'s own `<Suspense>` fallback while the query is pending. */
  queryLoading() {
    return container.queryByText("Loading...");
  },
  /**
   * The fallback rendered by the *ancestor* error boundary. `Scoreboard` owns
   * no boundary of its own — a failed query is meant to propagate upward — so
   * this models the boundary the match-details page supplies in production.
   */
  queryError() {
    return container.queryByRole("alert");
  },
  /** The `<section>` landmark `ScoreboardDisplay` renders once data arrives.
   * The page renders sibling region landmarks (e.g. the players panel), so
   * this resolves the one carrying the hero class. */
  getRegion() {
    const region = container
      .getAllByRole("region")
      .find((el: HTMLElement) => el.classList.contains("md-hero"));
    if (!region) {
      throw new Error("Unable to find the scoreboard's md-hero region");
    }
    return region;
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
 * Test page-object for the public `Scoreboard` wrapper. `Scoreboard` adds only
 * a `<Suspense>` boundary (with its real `Loading...` fallback) around
 * `ScoreboardFetcher` and forwards `matchId` through — it deliberately has
 * *no* error boundary, delegating failures upward. This renders it beneath an
 * `ErrorBoundary` standing in for that ancestor so a rejected query can be
 * observed reaching the boundary, and stubs the same
 * `GET /v1/matches/:matchId` endpoint the query reads.
 */
export const scoreboardPage = {
  /**
   * Stub `GET /v1/matches/:matchId` — `HttpResponse.json(buildMatchDetails())`
   * for the happy path, a non-2xx to drive the ancestor boundary.
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
        fallbackRender={() => (
          <div role="alert">Couldn’t load the scoreboard</div>
        )}
      >
        <Scoreboard {...props} />
      </ErrorBoundary>,
    );
  },

  /**
   * Scope the scoreboard accessors to a container — the whole `screen`
   * (default) or a `within(node)` subtree. A page object that embeds a
   * `Scoreboard` (e.g. the match-details hero) calls this to expose the same
   * region/heading queries as its own `.scoreboard`, rather than re-deriving
   * them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
