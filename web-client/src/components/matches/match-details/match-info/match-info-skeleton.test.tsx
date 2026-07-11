import { matchInfoDisplayPage } from "./match-info-fetcher/match-info-display.page";
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

  it("wears the shared design-system card, not the hand-rolled .md-card", () => {
    matchInfoSkeletonPage.render();

    const card = matchInfoSkeletonPage.getStatus();
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveAttribute("data-slot", "card");
    expect(card).not.toHaveClass("md-card");
  });

  // The half of the contract that matters: if the skeleton and the loaded panel
  // ever wear *different* chrome (one on the shared Card, one still hand-rolled;
  // one with a CardHeader, the other a bare div), the panel visibly resizes the
  // moment the data lands. Comparing the two chromes fails the moment they drift.
  it("wears the same card chrome as the loaded panel, so the panel doesn't jump on load", () => {
    matchInfoDisplayPage.render();
    matchInfoSkeletonPage.render();

    expect(matchInfoSkeletonPage.getCardChrome()).toEqual(
      matchInfoDisplayPage.getCardChrome(),
    );
  });
});
