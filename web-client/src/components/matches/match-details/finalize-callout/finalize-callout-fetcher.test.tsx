import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsGame,
  buildMatchDetailsScore,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { finalizeCalloutFetcherPage } from "./finalize-callout-fetcher.page";

/** A decided-but-unposted board (`can_finalize` with one saved score). */
const finalizableMatch = () =>
  buildMatchDetails({
    can_finalize: true,
    games: [
      buildMatchDetailsGame({ score: buildMatchDetailsScore() }),
    ],
  });

describe("FinalizeCalloutFetcher", () => {
  it("suspends until the query resolves, then hands the view to the display", async () => {
    finalizeCalloutFetcherPage.mockEndpoint(() =>
      HttpResponse.json(finalizableMatch()),
    );

    finalizeCalloutFetcherPage.render();

    // Pending: only the Suspense fallback, no callout yet.
    expect(finalizeCalloutFetcherPage.queryLoading()).toBeInTheDocument();
    expect(finalizeCalloutFetcherPage.queryCallout()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(finalizeCalloutFetcherPage.queryLoading());
    // Wiring only: callout content is pinned by the query and display tests.
    expect(finalizeCalloutFetcherPage.getCallout()).toBeInTheDocument();
  });

  it("renders nothing when the projection is null (nothing postable)", async () => {
    finalizeCalloutFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ can_finalize: false })),
    );

    finalizeCalloutFetcherPage.render();

    await waitForElementToBeRemoved(finalizeCalloutFetcherPage.queryLoading());
    expect(finalizeCalloutFetcherPage.queryCallout()).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    finalizeCalloutFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    finalizeCalloutFetcherPage.render();

    await waitForElementToBeRemoved(finalizeCalloutFetcherPage.queryLoading());
    expect(finalizeCalloutFetcherPage.queryError()).toBeInTheDocument();
  });
});
