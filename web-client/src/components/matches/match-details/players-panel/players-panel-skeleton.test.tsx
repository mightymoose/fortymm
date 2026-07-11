import { playersPanelSkeletonPage } from "./players-panel-skeleton.page";

describe("PlayersPanelSkeleton", () => {
  it("announces the load through a busy status region", () => {
    playersPanelSkeletonPage.render();

    const status = playersPanelSkeletonPage.getStatus();
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  // No-layout-shift contract: the skeleton reserves the same card + two-profile
  // grid the loaded panel renders, so swapping them shifts nothing. Both are on
  // the shared design-system Card (#218) — if only one moved, the panel would
  // visibly resize the moment the data arrived.
  it("reserves the shared Card chrome and the two-profile grid", () => {
    playersPanelSkeletonPage.render();

    const status = playersPanelSkeletonPage.getStatus();
    expect(status.tagName).toBe("SECTION");
    expect(playersPanelSkeletonPage.queryCard()).toBe(status);
    expect(status).not.toHaveClass("md-card");
    expect(playersPanelSkeletonPage.queryPlayersGrid()).not.toBeNull();
  });
});
