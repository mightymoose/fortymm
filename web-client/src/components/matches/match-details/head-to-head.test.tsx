import { HttpResponse } from "msw";

import {
  buildMatchDetails,
  buildMatchDetailsH2H,
} from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { headToHeadPage } from "./head-to-head.page";

/** A match carrying a head-to-head record — enough to show the card. */
const matchWithH2H = () =>
  buildMatchDetails({ head_to_head: buildMatchDetailsH2H() });

describe("HeadToHead", () => {
  it("shows its own Loading fallback until the query resolves, then the card", async () => {
    headToHeadPage.mockEndpoint(() => HttpResponse.json(matchWithH2H()));

    headToHeadPage.render();

    // Pending: only HeadToHead's real Suspense fallback, no card yet.
    expect(headToHeadPage.queryLoading()).toBeInTheDocument();
    expect(headToHeadPage.queryError()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(headToHeadPage.queryLoading());
    expect(headToHeadPage.getCard()).toBeInTheDocument();
  });

  it("forwards matchId to the underlying match-details query", async () => {
    let requestedMatchId: string | undefined;
    headToHeadPage.mockEndpoint(({ params }) => {
      requestedMatchId = params.matchId;
      return HttpResponse.json(matchWithH2H());
    });

    headToHeadPage.render({ matchId: "m-42" });

    await waitForElementToBeRemoved(headToHeadPage.queryLoading());
    expect(requestedMatchId).toBe("m-42");
  });

  it("displays the counts projected from the match details", async () => {
    headToHeadPage.mockEndpoint(() => HttpResponse.json(matchWithH2H()));

    headToHeadPage.render();

    await waitForElementToBeRemoved(headToHeadPage.queryLoading());
    // Wiring only: card content is pinned by the query and display tests.
    expect(headToHeadPage.getLeftCount()).toHaveTextContent(/^2$/);
  });

  it("renders nothing for a match with no head-to-head record", async () => {
    // The page mounts <HeadToHead> unconditionally; the hide-the-card gate
    // (no shared record) lives in the projection.
    headToHeadPage.mockEndpoint(() => HttpResponse.json(buildMatchDetails()));

    headToHeadPage.render();

    await waitForElementToBeRemoved(headToHeadPage.queryLoading());
    expect(headToHeadPage.queryCard()).not.toBeInTheDocument();
    expect(headToHeadPage.queryError()).not.toBeInTheDocument();
  });

  it("owns no error boundary — a failed query propagates to an ancestor boundary", async () => {
    headToHeadPage.mockEndpoint(() => new HttpResponse(null, { status: 500 }));

    headToHeadPage.render();

    await waitForElementToBeRemoved(headToHeadPage.queryLoading());
    expect(headToHeadPage.queryError()).toBeInTheDocument();
  });
});
