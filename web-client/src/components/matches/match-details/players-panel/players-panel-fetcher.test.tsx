import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { playersPanelFetcherPage } from "./players-panel-fetcher.page";

describe("PlayersPanelFetcher", () => {
  it("suspends while the query is pending, then hands the view to the display", async () => {
    playersPanelFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    playersPanelFetcherPage.render();

    expect(playersPanelFetcherPage.queryLoading()).toBeInTheDocument();
    expect(playersPanelFetcherPage.queryPanel()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(playersPanelFetcherPage.queryLoading());
    expect(playersPanelFetcherPage.getPanel()).toBeInTheDocument();
    // The default payload's current user, projected through the query.
    expect(
      playersPanelFetcherPage.profileFor("rita.kovac").getName("rita.kovac"),
    ).toBeInTheDocument();
  });

  it("lets a failed query reach the error boundary", async () => {
    playersPanelFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    playersPanelFetcherPage.render();

    await waitForElementToBeRemoved(playersPanelFetcherPage.queryLoading());
    expect(playersPanelFetcherPage.queryError()).toBeInTheDocument();
    expect(playersPanelFetcherPage.queryPanel()).not.toBeInTheDocument();
  });
});
