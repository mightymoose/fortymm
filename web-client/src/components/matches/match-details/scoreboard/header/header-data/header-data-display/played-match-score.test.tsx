import { describe, it, expect } from "vitest";
import { playedMatchScorePage } from "./played-match-score.page";
import { headerSideFactory, gameWonBy, matchScoreFactory } from "./match-score.factory";

describe("PlayedMatchScore", () => {
  const sides = [
    headerSideFactory({ username: "Ada" }),
    headerSideFactory({ username: "Bernie" }),
  ];

  it("tallies the games each player has won", () => {
    playedMatchScorePage.render(
      matchScoreFactory({
        sides,
        games: [gameWonBy(0), gameWonBy(1), gameWonBy(0)],
      }),
    );

    expect(playedMatchScorePage.forPlayer("Ada").score).toBe(2);
    expect(playedMatchScorePage.forPlayer("Bernie").score).toBe(1);
  });

  it("marks the player who has clinched the match as the winner", () => {
    playedMatchScorePage.render(
      matchScoreFactory({
        sides,
        games: [gameWonBy(0), gameWonBy(0)],
        bestOf: 3,
      }),
    );

    expect(playedMatchScorePage.forPlayer("Ada").won).toBe(true);
    expect(playedMatchScorePage.forPlayer("Bernie").won).toBe(false);
  });
});
