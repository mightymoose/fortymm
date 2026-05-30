import { describe, it, expect } from "vitest";
import { headerSkeletonPage } from "./header-skeleton.page";

describe("HeaderSkeleton", () => {
  it("renders a busy loading placeholder", () => {
    headerSkeletonPage.render();

    expect(headerSkeletonPage.isBusy).toBe(true);
  });

  it("reserves space for both the meta strip and the score row", () => {
    headerSkeletonPage.render();

    expect(headerSkeletonPage.hasScorePlaceholder).toBe(true);
    expect(headerSkeletonPage.placeholderCount).toBeGreaterThan(0);
  });
});
