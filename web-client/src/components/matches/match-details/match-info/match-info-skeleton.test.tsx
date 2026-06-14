import { matchInfoSkeletonPage } from "./match-info-skeleton.page";

describe("MatchInfoSkeleton", () => {
  it("announces the load through a busy status region", () => {
    matchInfoSkeletonPage.render();

    const status = matchInfoSkeletonPage.getStatus();
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  // No-layout-shift contract: the skeleton reserves the card and a few info
  // rows the loaded card renders, so swapping them shifts nothing.
  it("reserves the card and placeholder info rows", () => {
    matchInfoSkeletonPage.render();

    expect(matchInfoSkeletonPage.queryCard()).not.toBeNull();
    expect(matchInfoSkeletonPage.queryInfoRows().length).toBe(3);
  });
});
