import { screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { playerScorePage } from "./player-score.page";

describe("PlayerScore", () => {
  it("renders the score value", () => {
    playerScorePage.render({ label: "Ada sets", score: 3, won: false });
    expect(playerScorePage.score).toBe(3);
  });

  it("indicates when the score is a winning score", () => {
    playerScorePage.render({ label: "Ada sets", score: 3, won: true });
    expect(playerScorePage.won).toBe(true);
  });

  it("does not indicate when the score is not a winning score", () => {
    playerScorePage.render({ label: "Ada sets", score: 2, won: false });
    expect(playerScorePage.won).toBe(false);
  });

  it("applies the provided label", () => {
    playerScorePage.render({ label: "Ada, game 1", score: 1, won: false });
    const page = playerScorePage.within(screen.getByLabelText("Ada, game 1"));
    expect(page.score).toBe(1);
  });
});
