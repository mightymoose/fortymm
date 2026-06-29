import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { confirmationCalloutFetcherPage } from "./confirmation-callout-fetcher.page";

/** A live match with a standing proposal the opponent posted — the viewer must
 * act, so the callout renders its actionable variant. */
const reviewMatch = () =>
  buildMatchDetails({
    status: "in_progress",
    negotiation: {
      viewer_state: "review",
      your_turn: true,
      standing_result: {
        id: "r-1",
        games: [{ game_number: 1, side_1_points: 11, side_2_points: 7 }],
        submitted_by: "u-opponent",
        submitted_at: "2026-06-10T12:00:00Z",
      },
      prior_result: null,
      diff: null,
    },
  });

describe("ConfirmationCalloutFetcher", () => {
  it("suspends until the query resolves, then hands the view to the display", async () => {
    confirmationCalloutFetcherPage.mockEndpoint(() =>
      HttpResponse.json(reviewMatch()),
    );

    confirmationCalloutFetcherPage.render();

    // Pending: only the Suspense fallback, no callout yet.
    expect(confirmationCalloutFetcherPage.queryLoading()).toBeInTheDocument();
    expect(
      confirmationCalloutFetcherPage.queryCallout(),
    ).not.toBeInTheDocument();

    await waitForElementToBeRemoved(
      confirmationCalloutFetcherPage.queryLoading(),
    );
    // Wiring only: callout content is pinned by the query and display tests.
    expect(confirmationCalloutFetcherPage.getCallout()).toBeInTheDocument();
  });

  it("renders nothing when the projection is null (no sign-off in play)", async () => {
    confirmationCalloutFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    confirmationCalloutFetcherPage.render();

    await waitForElementToBeRemoved(
      confirmationCalloutFetcherPage.queryLoading(),
    );
    expect(
      confirmationCalloutFetcherPage.queryCallout(),
    ).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    confirmationCalloutFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    confirmationCalloutFetcherPage.render();

    await waitForElementToBeRemoved(
      confirmationCalloutFetcherPage.queryLoading(),
    );
    expect(confirmationCalloutFetcherPage.queryError()).toBeInTheDocument();
  });
});
