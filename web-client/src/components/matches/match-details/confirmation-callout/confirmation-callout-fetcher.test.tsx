import { HttpResponse } from "msw";

import {
  buildMatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { confirmationCalloutFetcherPage } from "./confirmation-callout-fetcher.page";

describe("ConfirmationCalloutFetcher", () => {
  it("suspends until the query resolves, then hands the view to the display", async () => {
    confirmationCalloutFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ can_confirm: true })),
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
      HttpResponse.json(buildMatchDetails({ can_confirm: false })),
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
