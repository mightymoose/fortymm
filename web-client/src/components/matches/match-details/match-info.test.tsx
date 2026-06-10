import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { matchInfoPage } from "./match-info.page";

describe("MatchInfo", () => {
  it("shows its own Loading fallback until the query resolves, then the card", async () => {
    matchInfoPage.mockEndpoint(() => HttpResponse.json(buildMatchDetails()));

    matchInfoPage.render();

    // Pending: only MatchInfo's real Suspense fallback, no card yet.
    expect(matchInfoPage.queryLoading()).toBeInTheDocument();
    expect(matchInfoPage.queryError()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(matchInfoPage.queryLoading());
    expect(matchInfoPage.getCard()).toBeInTheDocument();
  });

  it("forwards matchId to the underlying match-details query", async () => {
    let requestedMatchId: string | undefined;
    matchInfoPage.mockEndpoint(({ params }) => {
      requestedMatchId = params.matchId;
      return HttpResponse.json(buildMatchDetails());
    });

    matchInfoPage.render({ matchId: "m-42" });

    await waitForElementToBeRemoved(matchInfoPage.queryLoading());
    expect(requestedMatchId).toBe("m-42");
  });

  it("displays the rows projected from the match details", async () => {
    matchInfoPage.mockEndpoint(() => HttpResponse.json(buildMatchDetails()));

    matchInfoPage.render();

    await waitForElementToBeRemoved(matchInfoPage.queryLoading());
    // Wiring only: row content is pinned by the query and display tests.
    expect(matchInfoPage.getValue("Status")).toHaveTextContent(/^Scheduled$/);
  });

  it("owns no error boundary — a failed query propagates to an ancestor boundary", async () => {
    matchInfoPage.mockEndpoint(() => new HttpResponse(null, { status: 500 }));

    matchInfoPage.render();

    await waitForElementToBeRemoved(matchInfoPage.queryLoading());
    expect(matchInfoPage.queryError()).toBeInTheDocument();
  });
});
