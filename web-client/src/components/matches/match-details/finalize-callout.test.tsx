import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import {
  buildMatchDetails,
  buildMatchDetailsGame,
  buildMatchDetailsScore,
} from "@/mocks/factories/matches/match-details.factory";
import { waitFor, waitForElementToBeRemoved } from "@/test/utilities";

import { finalizeCalloutPage } from "./finalize-callout.page";

/** A decided-but-unposted board (`can_finalize` with one saved score). */
const finalizableMatch = () =>
  buildMatchDetails({
    can_finalize: true,
    games: [buildMatchDetailsGame({ score: buildMatchDetailsScore() })],
  });

describe("FinalizeCallout", () => {
  it("shows its Suspense fallback, then the callout for a finalizable board", async () => {
    finalizeCalloutPage.mockEndpoint(() =>
      HttpResponse.json(finalizableMatch()),
    );

    finalizeCalloutPage.render();

    expect(finalizeCalloutPage.queryLoading()).toBeInTheDocument();
    await waitForElementToBeRemoved(finalizeCalloutPage.queryLoading());
    // Wiring only: callout content is pinned by the display tests.
    expect(finalizeCalloutPage.getCallout()).toBeInTheDocument();
  });

  it("gives way once the result is posted (the resubmit-after-dispute flow)", async () => {
    // A dispute clears signatures but keeps the games, so the board is
    // re-postable as-is. After posting, the refetched payload is no longer
    // finalizable and the callout must disappear in place.
    let posted = false;
    finalizeCalloutPage.mockEndpoint(() =>
      HttpResponse.json(
        posted
          ? buildMatchDetails({ can_finalize: false })
          : finalizableMatch(),
      ),
    );
    finalizeCalloutPage.mockResultsEndpoint(() => {
      posted = true;
      return HttpResponse.json(buildMatchDetails({ can_finalize: false }), {
        status: 201,
      });
    });

    finalizeCalloutPage.render();

    await waitForElementToBeRemoved(finalizeCalloutPage.queryLoading());
    await userEvent.click(finalizeCalloutPage.getPostButton());

    await waitFor(() =>
      expect(finalizeCalloutPage.queryCallout()).not.toBeInTheDocument(),
    );
  });

  it("propagates a query failure to the ancestor error boundary", async () => {
    finalizeCalloutPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    finalizeCalloutPage.render();

    await waitForElementToBeRemoved(finalizeCalloutPage.queryLoading());
    expect(finalizeCalloutPage.queryBoundaryError()).toBeInTheDocument();
  });
});
