import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { scoreboardPage } from "./scoreboard.page";

/** A decided match whose selected view is a stable, assertable outcome. */
const decidedMatch = () =>
  buildMatchDetails({
    status_label: "Final",
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

describe("Scoreboard", () => {
  it("shows its own Loading fallback until the query resolves, then the region", async () => {
    scoreboardPage.mockEndpoint(() => HttpResponse.json(decidedMatch()));

    scoreboardPage.render();

    // Pending: only Scoreboard's real Suspense fallback, no region yet.
    expect(scoreboardPage.queryLoading()).toBeInTheDocument();
    expect(scoreboardPage.queryError()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(scoreboardPage.queryLoading());
    expect(scoreboardPage.getRegion()).toBeInTheDocument();
  });

  it("forwards matchId to the underlying match-details query", async () => {
    let requestedMatchId: string | undefined;
    scoreboardPage.mockEndpoint(({ params }) => {
      requestedMatchId = params.matchId;
      return HttpResponse.json(decidedMatch());
    });

    scoreboardPage.render({ matchId: "m-42" });

    await waitForElementToBeRemoved(scoreboardPage.queryLoading());
    expect(requestedMatchId).toBe("m-42");
  });

  it("displays the hero row projected from the match details", async () => {
    scoreboardPage.mockEndpoint(() => HttpResponse.json(decidedMatch()));

    scoreboardPage.render();

    await waitForElementToBeRemoved(scoreboardPage.queryLoading());
    // Wiring only: row content is pinned by the query and hero-row tests.
    const name = scoreboardPage.heroRow.getPlayerName("l", "rita.kovac");
    expect(scoreboardPage.getRegion()).toContainElement(name);
  });

  it("displays the heading strip projected from the match details", async () => {
    scoreboardPage.mockEndpoint(() =>
      HttpResponse.json({
        ...decidedMatch(),
        data: { scoreboard: { status: "final" } },
      }),
    );

    scoreboardPage.render();

    await waitForElementToBeRemoved(scoreboardPage.queryLoading());
    // Wiring only: heading content is pinned by the query and display tests.
    const chip = scoreboardPage.headingStrip.getChip();
    expect(chip).toHaveTextContent("Final");
    expect(scoreboardPage.getRegion()).toContainElement(chip);
  });

  it("displays the game grid projected from the match details", async () => {
    scoreboardPage.mockEndpoint(() =>
      HttpResponse.json({
        ...decidedMatch(),
        data: { scoreboard: { status: "final" } },
      }),
    );

    scoreboardPage.render();

    await waitForElementToBeRemoved(scoreboardPage.queryLoading());
    // Wiring only: grid content is pinned by the query and game-grid tests.
    const grid = scoreboardPage.gameGrid.getGrid();
    expect(scoreboardPage.getRegion()).toContainElement(grid);
    expect(scoreboardPage.gameGrid.getTotal("left")).toHaveTextContent("3");
  });

  it("owns no error boundary — a failed query propagates to an ancestor boundary", async () => {
    scoreboardPage.mockEndpoint(() => new HttpResponse(null, { status: 500 }));

    scoreboardPage.render();

    await waitForElementToBeRemoved(scoreboardPage.queryLoading());
    expect(scoreboardPage.queryError()).toBeInTheDocument();
  });
});
