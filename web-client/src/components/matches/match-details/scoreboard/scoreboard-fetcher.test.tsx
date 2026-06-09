import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved, within } from "@/test/utilities";

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

  it("calls the children render-prop with the selected ScoreboardView", async () => {
    const children = vi.fn(() => null);
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(decidedMatch()),
    );

    scoreboardFetcherPage.render({ children });

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    // Wiring only: the projected heading's content is pinned by the
    // scoreboard-query tests, the resulting DOM by the display tests.
    expect(children).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "scheduled",
        outcome: "rita.kovac defeated leo.mertens, 3 games to 1",
      }),
    );
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

  it("renders the children output inside the region", async () => {
    scoreboardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(decidedMatch()),
    );

    scoreboardFetcherPage.render({
      children: () => <p data-testid="scoreboard-body">live</p>,
    });

    await waitForElementToBeRemoved(scoreboardFetcherPage.queryLoading());
    expect(
      within(scoreboardFetcherPage.getRegion()).getByTestId("scoreboard-body"),
    ).toBeInTheDocument();
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
