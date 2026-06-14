import { actionBarPage } from "./action-bar.page";

describe("ActionBar", () => {
  it("renders the Matches title and the crumb copy", async () => {
    actionBarPage.render();

    await actionBarPage.findNewMatchLink();
    expect(actionBarPage.getNewMatchLink()).toBeInTheDocument();
    expect(actionBarPage.getExportLink().closest(".action-bar")).toHaveTextContent(
      "Matches",
    );
    expect(actionBarPage.getExportLink().closest(".action-bar")).toHaveTextContent(
      "Across tournaments, club nights, ladder & casual",
    );
  });

  it("renders the live count followed by ' LIVE' (e.g. '3 LIVE', not zero-padded)", async () => {
    actionBarPage.render({ liveCount: 3 });

    await actionBarPage.findNewMatchLink();
    expect(actionBarPage.getLivePill(3)).toHaveTextContent("3 LIVE");
  });

  it("links Export CSV to exportHref and marks it download", async () => {
    actionBarPage.render({ exportHref: "https://example.test/v1/matches.csv" });

    await actionBarPage.findNewMatchLink();
    const link = actionBarPage.getExportLink();
    expect(link).toHaveAttribute("href", "https://example.test/v1/matches.csv");
    expect(link).toHaveAttribute("download");
  });

  it("links + New match to /matches/new", async () => {
    actionBarPage.render();

    const link = await actionBarPage.findNewMatchLink();
    expect(link).toHaveAttribute("href", "/matches/new");
  });
});
