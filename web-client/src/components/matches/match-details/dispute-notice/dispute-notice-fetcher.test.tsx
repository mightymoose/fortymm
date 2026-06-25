import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { disputeNoticeFetcherPage } from "./dispute-notice-fetcher.page";

/** A disputed match the opponent (`u-opponent`) rejected, viewed by the
 * submitter (`u-me`) — projects to a non-null notice. */
const disputedByOpponent = () =>
  buildMatchDetails({
    status: "disputed",
    status_label: "Disputed",
    disputed_by_user_id: "u-opponent",
    signatures: [],
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "final" }),
    }),
  });

describe("DisputeNoticeFetcher", () => {
  it("suspends until the query resolves, then hands the view to the display", async () => {
    disputeNoticeFetcherPage.mockEndpoint(() =>
      HttpResponse.json(disputedByOpponent()),
    );

    disputeNoticeFetcherPage.render();

    // Pending: only the Suspense fallback, no notice yet.
    expect(disputeNoticeFetcherPage.queryLoading()).toBeInTheDocument();
    expect(disputeNoticeFetcherPage.queryNotice()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(disputeNoticeFetcherPage.queryLoading());
    // Wiring only: notice content is pinned by the query and display tests.
    expect(disputeNoticeFetcherPage.getNotice()).toBeInTheDocument();
  });

  it("renders nothing when the projection is null (not a dispute for this viewer)", async () => {
    disputeNoticeFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ status: "in_progress" })),
    );

    disputeNoticeFetcherPage.render();

    await waitForElementToBeRemoved(disputeNoticeFetcherPage.queryLoading());
    expect(disputeNoticeFetcherPage.queryNotice()).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    disputeNoticeFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    disputeNoticeFetcherPage.render();

    await waitForElementToBeRemoved(disputeNoticeFetcherPage.queryLoading());
    expect(disputeNoticeFetcherPage.queryError()).toBeInTheDocument();
  });
});
