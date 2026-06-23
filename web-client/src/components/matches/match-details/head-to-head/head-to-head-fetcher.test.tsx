import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsH2H,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { headToHeadFetcherPage } from "./head-to-head-fetcher.page";

/** A match carrying a head-to-head record — enough to show the card. */
const matchWithH2H = () =>
  buildMatchDetails({ head_to_head: buildMatchDetailsH2H() });

describe("HeadToHeadFetcher", () => {
  it("suspends while the query is pending, then hands the view to the display", async () => {
    headToHeadFetcherPage.mockEndpoint(() =>
      HttpResponse.json(matchWithH2H()),
    );

    headToHeadFetcherPage.render();

    // The row mounts under a router, so the fallback appears a tick after render.
    expect(await headToHeadFetcherPage.findLoading()).toBeInTheDocument();
    expect(headToHeadFetcherPage.queryCard()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(() => headToHeadFetcherPage.queryLoading());
    expect(headToHeadFetcherPage.getCard()).toBeInTheDocument();
    // The default record's counts, projected through the query.
    expect(headToHeadFetcherPage.getLeftCount()).toHaveTextContent(/^2$/);
  });

  it("renders nothing — no card, no error — when the projection is null", async () => {
    // The default match carries no head-to-head record.
    headToHeadFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    headToHeadFetcherPage.render();

    await headToHeadFetcherPage.findLoading();
    await waitForElementToBeRemoved(() => headToHeadFetcherPage.queryLoading());
    expect(headToHeadFetcherPage.queryCard()).not.toBeInTheDocument();
    expect(headToHeadFetcherPage.queryError()).not.toBeInTheDocument();
  });

  it("lets a failed query reach the error boundary", async () => {
    headToHeadFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    headToHeadFetcherPage.render();

    await headToHeadFetcherPage.findLoading();
    await waitForElementToBeRemoved(() => headToHeadFetcherPage.queryLoading());
    expect(headToHeadFetcherPage.queryError()).toBeInTheDocument();
    expect(headToHeadFetcherPage.queryCard()).not.toBeInTheDocument();
  });
});
