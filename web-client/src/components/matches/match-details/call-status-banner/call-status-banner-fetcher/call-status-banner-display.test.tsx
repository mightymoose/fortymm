import { callStatusBannerDisplayPage } from "./call-status-banner-display.page";

describe("CallStatusBannerDisplay", () => {
  it("renders nothing for a scorable match (kind: none) — AC #1/#6", async () => {
    callStatusBannerDisplayPage.render({ callStatus: { kind: "none" } });

    await callStatusBannerDisplayPage.findHarness();
    expect(callStatusBannerDisplayPage.queryBanner()).not.toBeInTheDocument();
  });

  it("names the event and the placed table when the tournament hasn't gone live yet, without promising a call", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: {
        kind: "awaiting_placement",
        tournamentName: "Summer Smash",
        eventName: "Open Singles",
        tableLabel: "Table 3",
      },
    });

    await callStatusBannerDisplayPage.findHarness();
    const banner = callStatusBannerDisplayPage.getBanner();
    expect(banner).toHaveTextContent(
      "This Open Singles fixture is placed on Table 3 in Summer Smash, but the tournament hasn't gone live yet.",
    );
    expect(banner).not.toHaveTextContent(/waiting to be called/i);
  });

  it("stays silent about any table when nothing has been placed yet, but still names the event", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: {
        kind: "awaiting_placement",
        tournamentName: "Summer Smash",
        eventName: "Open Singles",
        tableLabel: null,
      },
    });

    await callStatusBannerDisplayPage.findHarness();
    const banner = callStatusBannerDisplayPage.getBanner();
    expect(banner).toHaveTextContent(
      "This match is part of Open Singles in Summer Smash, which hasn't gone live yet.",
    );
  });

  it("gives the tournament owner a link into the tournament once it's live, naming the event (AC #2)", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: {
        kind: "awaiting_call",
        tournamentId: "t-1",
        tournamentName: "Summer Smash",
        eventName: "Open Singles",
        canEdit: true,
      },
    });

    const link = await callStatusBannerDisplayPage.findTournamentLink();
    expect(link).toHaveAttribute("href", "/tournaments/t-1");
    expect(callStatusBannerDisplayPage.getBanner()).toHaveTextContent(
      /Open Singles fixture/,
    );
  });

  it("gives a non-owner plain text naming the event and the director — no control they can't use (ADR-0015)", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: {
        kind: "awaiting_call",
        tournamentId: "t-1",
        tournamentName: "Summer Smash",
        eventName: "Open Singles",
        canEdit: false,
      },
    });

    await callStatusBannerDisplayPage.findHarness();
    expect(callStatusBannerDisplayPage.getBanner()).toHaveTextContent(
      "This Open Singles fixture is waiting for the tournament director to call it to a table.",
    );
    expect(
      callStatusBannerDisplayPage.queryTournamentLink(),
    ).not.toBeInTheDocument();
  });

  it("shows generic not-called copy with no tournament name when the tournament isn't visible to the viewer", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: { kind: "awaiting_call_hidden" },
    });

    await callStatusBannerDisplayPage.findHarness();
    const banner = callStatusBannerDisplayPage.getBanner();
    expect(banner).toHaveTextContent(
      "This match hasn't been called to a table yet.",
    );
  });

  it("distinguishes a posted result from the not-called cases", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: { kind: "result_posted" },
    });

    await callStatusBannerDisplayPage.findHarness();
    const banner = callStatusBannerDisplayPage.getBanner();
    expect(banner).toHaveTextContent(
      "This match has a posted result; scores are frozen.",
    );
    expect(banner).not.toHaveTextContent(/not been called/i);
  });

  it("mirrors the API's no_opponent message", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: { kind: "not_scorable", reason: "no_opponent" },
    });

    await callStatusBannerDisplayPage.findHarness();
    expect(callStatusBannerDisplayPage.getBanner()).toHaveTextContent(
      "This match has no opponent and can't be scored.",
    );
  });

  it("mirrors the API's generic not_scorable message", async () => {
    callStatusBannerDisplayPage.render({
      callStatus: { kind: "not_scorable", reason: "not_scorable" },
    });

    await callStatusBannerDisplayPage.findHarness();
    expect(callStatusBannerDisplayPage.getBanner()).toHaveTextContent(
      "This match is no longer scorable.",
    );
  });
});
