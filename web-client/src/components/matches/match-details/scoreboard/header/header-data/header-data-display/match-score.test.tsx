import { describe, it, expect } from "vitest";
import { matchScorePage } from "./match-score.page";
import { headerSideFactory, gameWonBy, matchScoreFactory } from "./match-score.factory";

describe("MatchScore", () => {
  const sides = [
    headerSideFactory({ username: "Ada" }),
    headerSideFactory({ username: "Bernie" }),
  ];

  // The played / upcoming branches are covered by their own suites; here we just
  // confirm MatchScore picks the layout from the resolved status.
  it("renders the played-match score for a final match", () => {
    matchScorePage.render(
      matchScoreFactory({
        status: { kind: "final" },
        sides,
        games: [gameWonBy(0), gameWonBy(1), gameWonBy(0)],
      }),
    );

    expect(matchScorePage.forPlayer("Ada").score).toBe(2);
    expect(matchScorePage.forPlayer("Bernie").score).toBe(1);
    expect(matchScorePage.hasVersusLabel()).toBe(false);
  });

  it("renders the upcoming (VS) layout for a pending match", () => {
    matchScorePage.render(
      matchScoreFactory({
        status: { kind: "upcoming", label: "Upcoming" },
        sides,
        games: [],
      }),
    );

    expect(matchScorePage.hasVersusLabel()).toBe(true);
    expect(matchScorePage.hasPlayer("Ada")).toBe(true);
    expect(matchScorePage.hasPlayer("Bernie")).toBe(true);
  });

  // Regression (#394): a live match between start and its first completed game
  // has no scored games yet, but its badge reads "Live · Game N". The score block
  // must agree — show 0 – 0, not the upcoming "VS" layout.
  it("renders 0 – 0 (not VS) for a live match with no completed game", () => {
    matchScorePage.render(
      matchScoreFactory({
        status: { kind: "live", gameNumber: 1 },
        sides,
        games: [],
      }),
    );

    expect(matchScorePage.hasVersusLabel()).toBe(false);
    expect(matchScorePage.forPlayer("Ada").score).toBe(0);
    expect(matchScorePage.forPlayer("Bernie").score).toBe(0);
  });

  it("places the first side on the left and the second on the right", () => {
    matchScorePage.render(
      matchScoreFactory({ status: { kind: "final" }, sides, games: [gameWonBy(0)] }),
    );

    expect(matchScorePage.playerOrder).toEqual(["Ada", "Bernie"]);
  });
});
