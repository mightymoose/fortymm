import { HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import {
  buildMatchDetails,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor, waitForElementToBeRemoved } from "@/test/utilities";

import { confirmationCalloutPage } from "./confirmation-callout.page";

/** A live match with a standing proposal the opponent posted — the viewer must
 * act, so the callout renders its actionable (Accept) variant. */
const reviewMatch = (): MatchDetails =>
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

const finalMatch = (): MatchDetails =>
  buildMatchDetails({
    status: "completed",
    status_label: "Final",
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "final" }),
    }),
  });

describe("ConfirmationCallout", () => {
  it("shows its Suspense fallback, then the callout when it's the viewer's turn", async () => {
    confirmationCalloutPage.mockEndpoint(() =>
      HttpResponse.json(reviewMatch()),
    );

    confirmationCalloutPage.render();

    expect(confirmationCalloutPage.queryLoading()).toBeInTheDocument();
    await waitForElementToBeRemoved(confirmationCalloutPage.queryLoading());
    // Wiring only: callout content is pinned by the display tests.
    expect(confirmationCalloutPage.getCallout()).toBeInTheDocument();
  });

  it("gives way once the viewer accepts and the match finalizes", async () => {
    // Accepting flips the refetched payload to final — neither callout state
    // applies any more, so the section must disappear in place.
    let accepted = false;
    confirmationCalloutPage.mockEndpoint(() =>
      HttpResponse.json(accepted ? finalMatch() : reviewMatch()),
    );
    confirmationCalloutPage.mockAcceptanceEndpoint(() => {
      accepted = true;
      return HttpResponse.json(finalMatch(), { status: 201 });
    });

    confirmationCalloutPage.render();

    await waitForElementToBeRemoved(confirmationCalloutPage.queryLoading());
    await userEvent.click(confirmationCalloutPage.getAcceptButton());

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
