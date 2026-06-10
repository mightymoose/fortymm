import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { matchInfoFetcherPage } from "./match-info-fetcher.page";

describe("MatchInfoFetcher", () => {
  it("suspends while the query is pending, then hands the view to the display", async () => {
    matchInfoFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    matchInfoFetcherPage.render();

    expect(matchInfoFetcherPage.queryLoading()).toBeInTheDocument();
    expect(matchInfoFetcherPage.queryCard()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(matchInfoFetcherPage.queryLoading());
    expect(matchInfoFetcherPage.getCard()).toBeInTheDocument();
    // The default payload's format line, projected through the query.
    expect(matchInfoFetcherPage.getValue("Format")).toHaveTextContent(
      /^Singles · Best of 5, first to 3$/,
    );
  });

  it("lets a failed query reach the error boundary", async () => {
    matchInfoFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    matchInfoFetcherPage.render();

    await waitForElementToBeRemoved(matchInfoFetcherPage.queryLoading());
    expect(matchInfoFetcherPage.queryError()).toBeInTheDocument();
    expect(matchInfoFetcherPage.queryCard()).not.toBeInTheDocument();
  });
});
