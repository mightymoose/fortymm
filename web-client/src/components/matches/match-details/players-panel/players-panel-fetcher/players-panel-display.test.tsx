import { buildPlayerProfileView } from "./players-panel-display/player-profile.factory";
import {
  buildPlayersPanelView,
  buildRookiePlayerProfileView,
} from "./players-panel-display.factory";
import { playersPanelDisplayPage } from "./players-panel-display.page";

describe("PlayersPanelDisplay", () => {
  // The panel wears the shared design-system Card (#218), not a hand-rolled
  // card class — but `asChild` must keep it a labelled `<section>` landmark.
  // A silent degrade to an anonymous card `<div>` would fail both halves here.
  it("renders a region landmark named by the visible card heading", () => {
    playersPanelDisplayPage.render();

    const panel = playersPanelDisplayPage.getPanel();
    expect(panel.tagName).toBe("SECTION");
    const id = playersPanelDisplayPage.getTitle().getAttribute("id");
    expect(id).toBeTruthy();
    expect(panel).toHaveAttribute("aria-labelledby", id);
  });

  it("takes its chrome from the shared Card, wrapping the two-profile grid", () => {
    playersPanelDisplayPage.render();

    const panel = playersPanelDisplayPage.getPanel();
    expect(panel).toHaveAttribute("data-slot", "card");
    expect(panel).not.toHaveClass("md-card");
    // The grid between the two halves is content, not chrome — it survives.
    expect(playersPanelDisplayPage.queryPlayersGrid()).not.toBeNull();
  });

  it("stamps the header with the view's snapshot label", () => {
    playersPanelDisplayPage.render({
      panel: buildPlayersPanelView({
        snapshotLabel: "SNAPSHOT · 8 JUN, 12:00",
      }),
    });

    expect(
      playersPanelDisplayPage.getSnapshotLabel("SNAPSHOT · 8 JUN, 12:00"),
    ).toBeInTheDocument();
  });

  // The caption must wear the same treatment as the head-to-head panel's — the
  // two cards sit side by side, and #218 is about making them look alike. Pin
  // the tokens: `text-muted-foreground` looks like the right design-system
  // choice but `.fortymm-theme` remaps it to a lighter grey (`--chalk-300`),
  // which would silently restyle a caption this chrome-only change must leave
  // untouched.
  it("captions the header in the muted grey the head-to-head panel uses", () => {
    playersPanelDisplayPage.render({
      panel: buildPlayersPanelView({ snapshotLabel: "SNAPSHOT · NOW" }),
    });

    const caption = playersPanelDisplayPage.getSnapshotLabel("SNAPSHOT · NOW");
    expect(caption).toHaveClass(
      "self-center",
      "text-[11px]",
      "font-medium",
      "tracking-[0.08em]",
      "text-[color:var(--fg-muted)]",
    );
    expect(caption).not.toHaveClass("text-muted-foreground");
  });

  it("renders a profile per side from the view", () => {
    // Wiring only: profile content is pinned by the query and profile tests.
    playersPanelDisplayPage.render({
      panel: buildPlayersPanelView({
        left: buildPlayerProfileView({ name: "rita.kovac" }),
        right: buildRookiePlayerProfileView({ name: "leo.mertens" }),
      }),
    });

    const rita = playersPanelDisplayPage.profileFor("rita.kovac");
    expect(rita.getRating("1612")).toBeInTheDocument();
    const leo = playersPanelDisplayPage.profileFor("leo.mertens");
    expect(leo.getUnrated()).toBeInTheDocument();
    expect(playersPanelDisplayPage.querySoloNote()).not.toBeInTheDocument();
  });

  it('renders the "No opponent" placeholder for a null right side', () => {
    playersPanelDisplayPage.render({
      panel: buildPlayersPanelView({ right: null }),
    });

    expect(playersPanelDisplayPage.getGhostName()).toBeInTheDocument();
    expect(playersPanelDisplayPage.getSoloNote()).toBeInTheDocument();
  });

  it('renders the "No opponent" placeholder for a null left side too', () => {
    playersPanelDisplayPage.render({
      panel: buildPlayersPanelView({ left: null }),
    });

    expect(playersPanelDisplayPage.getGhostName()).toBeInTheDocument();
  });
});
