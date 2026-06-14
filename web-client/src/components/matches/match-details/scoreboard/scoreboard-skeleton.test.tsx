import { scoreboardSkeletonPage } from "./scoreboard-skeleton.page";

describe("ScoreboardSkeleton", () => {
  it("announces the load through a busy status region", () => {
    scoreboardSkeletonPage.render();

    const status = scoreboardSkeletonPage.getStatus();
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  // No-layout-shift contract: the skeleton must reserve the same structural
  // regions the loaded scoreboard renders, so swapping them shifts nothing.
  it("reserves the heading strip, hero row, and game grid regions", () => {
    scoreboardSkeletonPage.render();

    expect(scoreboardSkeletonPage.queryHeadingStrip()).not.toBeNull();
    expect(scoreboardSkeletonPage.queryHeroRow()).not.toBeNull();
    expect(scoreboardSkeletonPage.queryGameGrid()).not.toBeNull();
  });
});
