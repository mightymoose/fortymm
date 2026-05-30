import { describe, it, expect } from "vitest";
import { lineScoreSkeletonPage } from "./line-score-skeleton.page";

describe("LineScoreSkeleton", () => {
  it("reserves the line-score grid while the data loads", () => {
    lineScoreSkeletonPage.render();

    expect(lineScoreSkeletonPage.hasGridPlaceholder).toBe(true);
    expect(lineScoreSkeletonPage.placeholderCount).toBeGreaterThan(0);
  });

  it("reserves a row for each of the two sides", () => {
    lineScoreSkeletonPage.render();

    expect(lineScoreSkeletonPage.rowCount).toBe(2);
  });

  it("hides the game-column labels until the real game count is known", () => {
    lineScoreSkeletonPage.render();

    expect(lineScoreSkeletonPage.columnLabels.every((label) => label === "")).toBe(
      true,
    );
  });
});
