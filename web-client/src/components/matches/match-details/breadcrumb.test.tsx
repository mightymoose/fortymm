import { HttpResponse } from "msw";

import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import { breadcrumbPage } from "./breadcrumb.page";

describe("Breadcrumb", () => {
  it("shows the Matches parent link and the current-match label for a casual match — pixel-identical to before #1288 (AC #8)", async () => {
    breadcrumbPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          id: "abcdef0000",
          tournament: undefined,
          not_scorable_reason: null,
        }),
      ),
    );

    breadcrumbPage.render({ matchId: "abcdef0000" });

    await breadcrumbPage.findCurrent("Match abcdef");
    expect(breadcrumbPage.queryMatchesLink()).toHaveAttribute(
      "href",
      "/matches",
    );
    expect(
      breadcrumbPage.queryTournamentLink("Summer Smash"),
    ).not.toBeInTheDocument();
  });

  it("inserts the tournament crumb once the query resolves for a tournament fixture (AC #2)", async () => {
    breadcrumbPage.mockEndpoint(() =>
      HttpResponse.json(
        buildMatchDetails({
          id: "abcdef0000",
          tournament: {
            tournament_id: "t-1",
            tournament_name: "Summer Smash",
            tournament_status: "live",
            event_id: "e-1",
            event_name: "Open Singles",
            table_label: "Table 3",
            can_edit: true,
          },
        }),
      ),
    );

    breadcrumbPage.render({ matchId: "abcdef0000" });

    const tournamentLink = await breadcrumbPage.findTournamentLink(
      "Summer Smash",
    );
    expect(tournamentLink).toHaveAttribute("href", "/tournaments/t-1");
    await breadcrumbPage.findCurrent("Match abcdef");
  });

  it("propagates a failed query to the ancestor error boundary", async () => {
    breadcrumbPage.mockEndpoint(() => new HttpResponse(null, { status: 500 }));

    breadcrumbPage.render({ matchId: "abcdef0000" });

    await waitFor(() => expect(breadcrumbPage.queryError()).toBeInTheDocument());
  });
});
