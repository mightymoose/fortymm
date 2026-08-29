import { breadcrumbDisplayPage } from "./breadcrumb-display.page";

describe("BreadcrumbDisplay", () => {
  it("shows the Matches parent link and the current-match label for a casual match (no tournament crumb)", async () => {
    breadcrumbDisplayPage.render({ matchId: "abcdef0000", tournament: null });

    await breadcrumbDisplayPage.findCurrent("Match abcdef");
    expect(breadcrumbDisplayPage.queryMatchesLink()).toHaveAttribute(
      "href",
      "/matches",
    );
    // AC #8: a casual match renders exactly as it did before #1288 — no
    // tournament crumb of any kind.
    expect(
      breadcrumbDisplayPage.queryTournamentLink("Summer Smash"),
    ).not.toBeInTheDocument();
  });

  it("inserts a tournament crumb linking to the tournament, between Matches and the current-match label", async () => {
    breadcrumbDisplayPage.render({
      matchId: "abcdef0000",
      tournament: { tournamentId: "t-1", tournamentName: "Summer Smash" },
    });

    const tournamentLink = await breadcrumbDisplayPage.findTournamentLink(
      "Summer Smash",
    );
    expect(tournamentLink).toHaveAttribute("href", "/tournaments/t-1");
    expect(breadcrumbDisplayPage.queryMatchesLink()).toHaveAttribute(
      "href",
      "/matches",
    );
    await breadcrumbDisplayPage.findCurrent("Match abcdef");
  });
});
