import { describe, it, expect } from "vitest";
import { matchScorePage } from "./match-score.page";
import { headerSideFactory, gameWonBy, matchScoreFactory } from "./match-score.factory";

describe("MatchScore", () => {
  const sides = [
    headerSideFactory({ username: "Ada" }),
    headerSideFactory({ username: "Bernie" }),
  ];

  // The played / upcoming branches are covered by their own suites; here we just
  // confirm MatchScore renders the played-match score for a started match.
  it("renders the played-match score", () => {
    matchScorePage.render(
      matchScoreFactory({
        sides,
        games: [gameWonBy(0), gameWonBy(1), gameWonBy(0)],
      }),
    );

    expect(matchScorePage.forPlayer("Ada").score).toBe(2);
    expect(matchScorePage.forPlayer("Bernie").score).toBe(1);
    expect(matchScorePage.hasVersusLabel()).toBe(false);
  });

  it("renders the upcoming-match score when no games have been played", () => {
    matchScorePage.render(matchScoreFactory({ sides, games: [] }));

    expect(matchScorePage.hasVersusLabel()).toBe(true);
    expect(matchScorePage.hasPlayer("Ada")).toBe(true);
    expect(matchScorePage.hasPlayer("Bernie")).toBe(true);
  });

  it("places the first side on the left and the second on the right", () => {
    matchScorePage.render(
      matchScoreFactory({ sides, games: [gameWonBy(0)] }),
    );

    expect(matchScorePage.playerOrder).toEqual(["Ada", "Bernie"]);
  });
});
