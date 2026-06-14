import { playersPanelSkeletonPage } from "./players-panel-skeleton.page";

describe("PlayersPanelSkeleton", () => {
  it("announces the load through a busy status region", () => {
    playersPanelSkeletonPage.render();

    const status = playersPanelSkeletonPage.getStatus();
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  // No-layout-shift contract: the skeleton reserves the same card + two-profile
  // grid the loaded panel renders, so swapping them shifts nothing.
  it("reserves the card and the two-profile grid", () => {
    playersPanelSkeletonPage.render();

    expect(playersPanelSkeletonPage.queryCard()).not.toBeNull();
    expect(playersPanelSkeletonPage.queryPlayersGrid()).not.toBeNull();
  });
});
