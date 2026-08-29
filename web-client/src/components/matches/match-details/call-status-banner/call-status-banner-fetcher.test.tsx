import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { callStatusBannerFetcherPage } from "./call-status-banner-fetcher.page";

describe("CallStatusBannerFetcher", () => {
  it("suspends while the query is pending, then hands the view to the display", async () => {
    callStatusBannerFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({ not_scorable_reason: "result_posted" }),
      ),
    );

    callStatusBannerFetcherPage.render();

    expect(callStatusBannerFetcherPage.queryLoading()).toBeInTheDocument();
    expect(callStatusBannerFetcherPage.queryBanner()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(callStatusBannerFetcherPage.queryLoading());
    expect(callStatusBannerFetcherPage.getBanner()).toHaveTextContent(
      "This match has a posted result; scores are frozen.",
    );
  });

  it("renders nothing once resolved for a scorable match — no banner clutter", async () => {
    callStatusBannerFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ not_scorable_reason: null })),
    );

    callStatusBannerFetcherPage.render();

    await waitForElementToBeRemoved(callStatusBannerFetcherPage.queryLoading());
    expect(callStatusBannerFetcherPage.queryBanner()).not.toBeInTheDocument();
  });

  it("lets a failed query reach the error boundary", async () => {
    callStatusBannerFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    callStatusBannerFetcherPage.render();

    await waitForElementToBeRemoved(callStatusBannerFetcherPage.queryLoading());
    expect(callStatusBannerFetcherPage.queryError()).toBeInTheDocument();
  });
});
