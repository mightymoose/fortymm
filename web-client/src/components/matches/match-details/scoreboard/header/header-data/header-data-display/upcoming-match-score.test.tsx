import { describe, it, expect } from "vitest";
import { upcomingMatchScorePage } from "./upcoming-match-score.page";
import { headerSideFactory, upcomingMatchScoreFactory } from "./match-score.factory";

describe("UpcomingMatchScore", () => {
  const sides = [
    headerSideFactory({ username: "Ada" }),
    headerSideFactory({ username: "Bernie" }),
  ];

  it("shows both players", () => {
    upcomingMatchScorePage.render(upcomingMatchScoreFactory({ sides }));

    expect(upcomingMatchScorePage.hasPlayer("Ada")).toBe(true);
    expect(upcomingMatchScorePage.hasPlayer("Bernie")).toBe(true);
  });

  it('shows "VS" instead of a score line', () => {
    upcomingMatchScorePage.render(upcomingMatchScoreFactory({ sides }));

    expect(upcomingMatchScorePage.hasVersusLabel).toBe(true);
    expect(upcomingMatchScorePage.scoreFor("Ada")).toBeNull();
    expect(upcomingMatchScorePage.scoreFor("Bernie")).toBeNull();
  });
});
