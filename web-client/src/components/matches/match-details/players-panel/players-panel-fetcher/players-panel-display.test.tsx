import { buildPlayerProfileView } from "./players-panel-display/player-profile.factory";
import {
  buildPlayersPanelView,
  buildRookiePlayerProfileView,
} from "./players-panel-display.factory";
import { playersPanelDisplayPage } from "./players-panel-display.page";

describe("PlayersPanelDisplay", () => {
  it("renders a region landmark named by the visible card heading", () => {
    playersPanelDisplayPage.render();

    const panel = playersPanelDisplayPage.getPanel();
    expect(panel).toHaveClass("md-card");
    const id = playersPanelDisplayPage.getTitle().getAttribute("id");
    expect(id).toBeTruthy();
    expect(panel).toHaveAttribute("aria-labelledby", id);
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
