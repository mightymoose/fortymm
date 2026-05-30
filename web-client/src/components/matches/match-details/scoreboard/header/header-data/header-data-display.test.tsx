import { describe, it, expect } from "vitest";
import { matchHeaderDataDisplayPage } from "./header-data-display.page";
import { matchHeaderDataDisplayFactory } from "./header-data-display.factory";
import { headerSideFactory, gameWonBy } from "./header-data-display/match-score.factory";

describe("MatchHeaderDataDisplay", () => {
  const sides = [
    headerSideFactory({ username: "Ada" }),
    headerSideFactory({ username: "Bernie" }),
  ];

  it("wires the match details through to the Meta strip", () => {
    matchHeaderDataDisplayPage.render(
      matchHeaderDataDisplayFactory({ status: { kind: "final" }, bestOf: 7 }),
    );

    expect(matchHeaderDataDisplayPage.meta.format).toBe("SINGLES · BO7");
    expect(matchHeaderDataDisplayPage.meta.firstTo).toBe(4);
  });

  it("wires the players and games through to the match score", () => {
    matchHeaderDataDisplayPage.render(
      matchHeaderDataDisplayFactory({
        sides,
        games: [gameWonBy(0), gameWonBy(1), gameWonBy(0)],
      }),
    );

    expect(matchHeaderDataDisplayPage.score.forPlayer("Ada").score).toBe(2);
    expect(matchHeaderDataDisplayPage.score.forPlayer("Bernie").score).toBe(1);
  });

  it("shows the upcoming match score when no games have been played", () => {
    matchHeaderDataDisplayPage.render(
      matchHeaderDataDisplayFactory({
        sides,
        status: { kind: "upcoming", label: "Sat 10am" },
        games: [],
      }),
    );

    expect(matchHeaderDataDisplayPage.score.hasVersusLabel()).toBe(true);
  });
});
