import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitForElementToBeRemoved } from "@/test/utilities";

import { playersPanelPage } from "./players-panel.page";

describe("PlayersPanel", () => {
  it("shows its own Loading fallback until the query resolves, then the panel", async () => {
    playersPanelPage.mockEndpoint(() => HttpResponse.json(buildMatchDetails()));

    playersPanelPage.render();

    // Pending: only PlayersPanel's real Suspense fallback, no panel yet.
    expect(playersPanelPage.queryLoading()).toBeInTheDocument();
    expect(playersPanelPage.queryError()).not.toBeInTheDocument();

    await waitForElementToBeRemoved(playersPanelPage.queryLoading());
    expect(playersPanelPage.getPanel()).toBeInTheDocument();
  });

  it("forwards matchId to the underlying match-details query", async () => {
    let requestedMatchId: string | undefined;
    playersPanelPage.mockEndpoint(({ params }) => {
      requestedMatchId = params.matchId;
      return HttpResponse.json(buildMatchDetails());
    });

    playersPanelPage.render({ matchId: "m-42" });

    await waitForElementToBeRemoved(playersPanelPage.queryLoading());
    expect(requestedMatchId).toBe("m-42");
  });

  it("displays both player profiles projected from the match details", async () => {
    playersPanelPage.mockEndpoint(() => HttpResponse.json(buildMatchDetails()));

    playersPanelPage.render();

    await waitForElementToBeRemoved(playersPanelPage.queryLoading());
    // Wiring only: profile content is pinned by the query and display tests.
    const rita = playersPanelPage.profileFor("rita.kovac");
    expect(rita.getName("rita.kovac")).toBeInTheDocument();
    const leo = playersPanelPage.profileFor("leo.mertens");
    expect(leo.getName("leo.mertens")).toBeInTheDocument();
  });

  it("owns no error boundary — a failed query propagates to an ancestor boundary", async () => {
    playersPanelPage.mockEndpoint(() => new HttpResponse(null, { status: 500 }));

    playersPanelPage.render();

    await waitForElementToBeRemoved(playersPanelPage.queryLoading());
    expect(playersPanelPage.queryError()).toBeInTheDocument();
  });
});
