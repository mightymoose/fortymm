import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { scoreCtaFetcherPage } from "./score-cta-fetcher.page";

/** A scorable match: the viewer can score the open current game. */
const scorableMatch = () =>
  buildMatchDetails({ can_score: true, current_game: { game_number: 1 } });

describe("ScoreCtaFetcher", () => {
  it("resolves the query and hands the view to the display", async () => {
    scoreCtaFetcherPage.mockEndpoint(() => HttpResponse.json(scorableMatch()));

    scoreCtaFetcherPage.render();

    // Wiring only: the link's target is pinned by the query and display tests.
    expect(await scoreCtaFetcherPage.findScoreLink()).toBeInTheDocument();
  });

  it("renders nothing when the projection is null (nothing to score)", async () => {
    scoreCtaFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildMatchDetails({ can_score: false })),
    );

    scoreCtaFetcherPage.render();

    // Settles to nothing: no loading, no CTA, no error.
    await waitFor(() =>
      expect(scoreCtaFetcherPage.queryLoading()).not.toBeInTheDocument(),
    );
    expect(scoreCtaFetcherPage.queryScoreLink()).not.toBeInTheDocument();
    expect(scoreCtaFetcherPage.queryError()).not.toBeInTheDocument();
  });

  it("propagates a query failure to the nearest error boundary", async () => {
    scoreCtaFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    scoreCtaFetcherPage.render();

    await waitFor(() =>
      expect(scoreCtaFetcherPage.queryError()).toBeInTheDocument(),
    );
  });
});
