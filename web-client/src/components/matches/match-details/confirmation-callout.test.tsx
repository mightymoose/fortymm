import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor, waitForElementToBeRemoved } from "@/test/utilities";

import { confirmationCalloutPage } from "./confirmation-callout.page";

describe("ConfirmationCallout", () => {
  it("shows its Suspense fallback, then the callout when the viewer can confirm", async () => {
    confirmationCalloutPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ can_confirm: true })),
    );

    confirmationCalloutPage.render();

    expect(confirmationCalloutPage.queryLoading()).toBeInTheDocument();
    await waitForElementToBeRemoved(confirmationCalloutPage.queryLoading());
    // Wiring only: callout content is pinned by the display tests.
    expect(confirmationCalloutPage.getCallout()).toBeInTheDocument();
  });

  it("gives way once the viewer confirms and the match finalizes", async () => {
    // Confirming flips the refetched payload to final-with-signatures —
    // neither callout state applies any more, so the section must disappear
    // in place (the in-page continuation of #358).
    let confirmed = false;
    confirmationCalloutPage.mockEndpoint(() =>
      HttpResponse.json(
        confirmed
          ? buildMatchDetails({
              can_confirm: false,
              status: "completed",
              status_label: "Final",
              data: buildMatchDetailsData({
                scoreboard: buildScoreboard({ status: "final" }),
              }),
            })
          : buildMatchDetails({ can_confirm: true }),
      ),
    );
    confirmationCalloutPage.mockConfirmationEndpoint(() => {
      confirmed = true;
      return HttpResponse.json(buildMatchDetails({ can_confirm: false }), {
        status: 201,
      });
    });

    confirmationCalloutPage.render();

    await waitForElementToBeRemoved(confirmationCalloutPage.queryLoading());
    await userEvent.click(confirmationCalloutPage.getConfirmButton());

    await waitFor(() =>
      expect(confirmationCalloutPage.queryCallout()).not.toBeInTheDocument(),
    );
  });

  it("propagates a query failure to the ancestor error boundary", async () => {
    confirmationCalloutPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    confirmationCalloutPage.render();

    await waitForElementToBeRemoved(confirmationCalloutPage.queryLoading());
    expect(confirmationCalloutPage.queryBoundaryError()).toBeInTheDocument();
  });
});
