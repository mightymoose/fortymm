import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsGame,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { scoreboardFetcherPage } from "./scoreboard-fetcher.page";

/** A decided match whose selected view is a stable, assertable outcome. */
const decidedMatch = () =>
  buildMatchDetails({
    sides: [
      buildMatchDetailsSide({
        won: true,
        games_won: 3,
        players: [buildMatchDetailsPlayer({ username: "rita.kovac" })],
      }),
      buildMatchDetailsSide({
        side_number: 2,
        won: false,
        games_won: 1,
        players: [buildMatchDetailsPlayer({ username: "leo.mertens" })],
      }),
    ],
  });

describe("ScoreboardFetcher", () => {
  it("suspends until the query resolves, showing no scoreboard before data", async () => {
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(decidedMatch()),
    );

    scoreboardFetcherPage.render();

    // Pending: only the Suspense fallback, no region yet.
    expect(scoreboardFetcherPage.queryLoading()).toBeInTheDocument();
    expect(scoreboardFetcherPage.queryError()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    expect(scoreboardFetcherPage.getRegion()).toBeInTheDocument();
  });

  it("hands the resolved outcome to ScoreboardDisplay's heading", async () => {
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(decidedMatch()),
    );

    scoreboardFetcherPage.render();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    expect(scoreboardFetcherPage.getHeading()).toHaveTextContent(
      "rita.kovac defeated leo.mertens, 3 games to 1",
    );
    // The region is labelled by that heading — the full display handoff.
    expect(scoreboardFetcherPage.getRegion()).toHaveAttribute(
      "aria-labelledby",
      scoreboardFetcherPage.getHeading().getAttribute("id"),
    );
  });

  it("renders the hero row from the selected view", async () => {
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(decidedMatch()),
    );

    scoreboardFetcherPage.render();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    // Wiring only: row content is pinned by the query and hero-row tests.
    const name = scoreboardFetcherPage.heroRow.getPlayerName(
      "l",
      "rita.kovac",
    );
    expect(scoreboardFetcherPage.getRegion()).toContainElement(name);
  });

  it("renders the heading strip from the selected view", async () => {
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ data: { scoreboard: { status: "final" } } }),
      ),
    );

    scoreboardFetcherPage.render();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    expect(scoreboardFetcherPage.headingStrip.getChip()).toHaveTextContent(
      "Final",
    );
  });

  it("renders the game grid from the selected view for a live match", async () => {
    // Wiring only: grid content is pinned by the query and game-grid tests.
    // The game stays unscored so no cell needs a router for an edit link.
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          games: [buildMatchDetailsGame()],
          data: { scoreboard: { status: "live" } },
        }),
      ),
    );

    scoreboardFetcherPage.render();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    const grid = scoreboardFetcherPage.gameGrid.getGrid();
    expect(scoreboardFetcherPage.getRegion()).toContainElement(grid);
  });

  it("omits the game grid for a scheduled match", async () => {
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ data: { scoreboard: { status: "scheduled" } } }),
      ),
    );

    scoreboardFetcherPage.render();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    expect(
      scoreboardFetcherPage.gameGrid.queryGrid(),
    ).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    scoreboardFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    scoreboardFetcherPage.render();

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    expect(scoreboardFetcherPage.queryError()).toBeInTheDocument();
  });
});
