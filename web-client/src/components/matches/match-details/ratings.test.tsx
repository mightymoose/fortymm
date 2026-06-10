import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { ratingsPage } from "./ratings.page";

/** A completed match whose viewer side moved +12 — enough to show the card. */
const finalRatedMatch = () =>
  buildMatchDetails({
    status: "completed",
    status_label: "Final",
    sides: [
      buildMatchDetailsSide({
        games_won: 3,
        won: true,
        rating_change: { before: 1612, after: 1624, delta: 12 },
      }),
      buildMatchDetailsSide({
        side_number: 2,
        players: [],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      }),
    ],
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "final" }),
    }),
  });

describe("Ratings", () => {
  it("shows its own Loading fallback until the query resolves, then the card", async () => {
    ratingsPage.mockEndpoint(() => HttpResponse.json(finalRatedMatch()));

    ratingsPage.render();

    // Pending: only Ratings's real Suspense fallback, no card yet.
    expect(ratingsPage.queryLoading()).toBeInTheDocument();
    expect(ratingsPage.queryError()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(ratingsPage.queryLoading());
    expect(ratingsPage.getCard()).toBeInTheDocument();
  });

  it("forwards matchId to the underlying match-details query", async () => {
    let requestedMatchId: string | undefined;
    ratingsPage.mockEndpoint(({ params }) => {
      requestedMatchId = params.matchId;
      return HttpResponse.json(finalRatedMatch());
    });

    ratingsPage.render({ matchId: "m-42" });

    await waitForElementToBeRemoved(ratingsPage.queryLoading());
    expect(requestedMatchId).toBe("m-42");
  });

  it("displays the rows projected from the match details", async () => {
    ratingsPage.mockEndpoint(() => HttpResponse.json(finalRatedMatch()));

    ratingsPage.render();

    await waitForElementToBeRemoved(ratingsPage.queryLoading());
    // Wiring only: row content is pinned by the query and rating-row tests.
    expect(ratingsPage.queryDelta("rita.kovac")).toHaveTextContent(/^\+12$/);
  });

  it("renders nothing for a match with no visible rating change", async () => {
    // The page mounts <Ratings> unconditionally; the hide-the-card gate
    // (not final / no movement) lives in the projection.
    ratingsPage.mockEndpoint(() => HttpResponse.json(buildMatchDetails()));

    ratingsPage.render();

    await waitForElementToBeRemoved(ratingsPage.queryLoading());
    expect(ratingsPage.queryCard()).not.toBeInTheDocument();
    expect(ratingsPage.queryError()).not.toBeInTheDocument();
  });

  it("owns no error boundary — a failed query propagates to an ancestor boundary", async () => {
    ratingsPage.mockEndpoint(() => new HttpResponse(null, { status: 500 }));

    ratingsPage.render();

    await waitForElementToBeRemoved(ratingsPage.queryLoading());
    expect(ratingsPage.queryError()).toBeInTheDocument();
  });
});
