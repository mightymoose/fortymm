import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsPlayer,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import {
  buildMatchDetailsData,
  buildScoreboard,
} from "@/mocks/factories/matches/scoreboard.factory";
import { waitFor } from "@/test/utilities";

import { saveYourMatchFetcherPage } from "./save-your-match-fetcher.page";

/** A live match the viewer is playing against a real opponent — the query
 * projects a non-null view, so the display should render. */
const savableMatch = () =>
  buildMatchDetails({
    status: "in_progress",
    status_label: "Live",
    sides: [
      buildMatchDetailsSide({ games_won: 3, won: true }),
      buildMatchDetailsSide({
        side_number: 2,
        players: [
          buildMatchDetailsPlayer({
            user_id: "u-opponent",
            username: "leo.mertens",
            is_current_user: false,
          }),
        ],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      }),
    ],
    data: buildMatchDetailsData({
      scoreboard: buildScoreboard({ status: "live" }),
    }),
  });

describe("SaveYourMatchFetcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("resolves the query and hands the view to the display", async () => {
    saveYourMatchFetcherPage.mockEndpoint(() =>
      HttpResponse.json(savableMatch()),
    );
    saveYourMatchFetcherPage.mockSession({
      user: { email: null, confirmed_at: null },
    });

    saveYourMatchFetcherPage.render();

    // Wiring only: the prompt's content is pinned by the display tests, and
    // the null/spectator/ghost projection by the query tests.
    expect(await saveYourMatchFetcherPage.findPrompt()).toBeInTheDocument();
  });

  it("renders nothing when the projection is null (nothing to save yet)", async () => {
    // The default factory match is still scheduled → null projection.
    saveYourMatchFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails()),
    );

    saveYourMatchFetcherPage.render();

    // Settles to nothing: no loading, no prompt, no error.
    await waitFor(() =>
      expect(saveYourMatchFetcherPage.queryLoading()).not.toBeInTheDocument(),
    );
    expect(saveYourMatchFetcherPage.queryPrompt()).not.toBeInTheDocument();
    expect(saveYourMatchFetcherPage.queryError()).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    saveYourMatchFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    saveYourMatchFetcherPage.render();

    await waitFor(() =>
      expect(saveYourMatchFetcherPage.queryError()).toBeInTheDocument(),
    );
  });
});
