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

import { ratingsFetcherPage } from "./ratings-fetcher.page";

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

describe("RatingsFetcher", () => {
  it("suspends while the query is pending, then hands the view to the display", async () => {
    ratingsFetcherPage.mockEndpoint(() =>
      HttpResponse.json(finalRatedMatch()),
    );

    ratingsFetcherPage.render();

    expect(ratingsFetcherPage.queryLoading()).toBeInTheDocument();
    expect(ratingsFetcherPage.queryCard()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(ratingsFetcherPage.queryLoading());
    expect(ratingsFetcherPage.getCard()).toBeInTheDocument();
    // The default payload's winner delta, projected through the query.
    expect(ratingsFetcherPage.queryDelta("rita.kovac")).toHaveTextContent(
      /^\+12$/,
    );
  });

  it("renders nothing — no card, no error — when the projection is null", async () => {
    // The default match is scheduled with no rating movement.
    ratingsFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    ratingsFetcherPage.render();

    await waitForElementToBeRemoved(ratingsFetcherPage.queryLoading());
    expect(ratingsFetcherPage.queryCard()).not.toBeInTheDocument();
    expect(ratingsFetcherPage.queryError()).not.toBeInTheDocument();
  });

  it("lets a failed query reach the error boundary", async () => {
    ratingsFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    ratingsFetcherPage.render();

    await waitForElementToBeRemoved(ratingsFetcherPage.queryLoading());
    expect(ratingsFetcherPage.queryError()).toBeInTheDocument();
    expect(ratingsFetcherPage.queryCard()).not.toBeInTheDocument();
  });
});
