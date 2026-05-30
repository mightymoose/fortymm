import { describe, it, expect } from "vitest";
import { lineScoreDataDisplayPage } from "./line-score-data-display.page";
import { lineScoreDataDisplayFactory } from "./line-score-data-display.factory";
import { lineSideFactory, game } from "./line-score-data-display/line.factory";

describe("LineScoreDataDisplay", () => {
  const sides = [
    lineSideFactory({ username: "Ada" }),
    lineSideFactory({ username: "Bernie" }),
  ];

  it("renders a row for every side", () => {
    lineScoreDataDisplayPage.render(lineScoreDataDisplayFactory({ sides }));

    expect(lineScoreDataDisplayPage.line.forUser("Ada").exists).toBe(true);
    expect(lineScoreDataDisplayPage.line.forUser("Bernie").exists).toBe(true);
  });

  it("lays the grid out for the match's best-of", () => {
    lineScoreDataDisplayPage.render(
      lineScoreDataDisplayFactory({ sides, bestOf: 7 }),
    );

    expect(lineScoreDataDisplayPage.grid.columnLabels).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
    ]);
  });

  it("wires each side's per-game points into its row", () => {
    lineScoreDataDisplayPage.render(
      lineScoreDataDisplayFactory({ sides, games: [game(11, 7), game(9, 11)] }),
    );

    expect(lineScoreDataDisplayPage.line.forUser("Ada").game(1).score).toBe(11);
    expect(lineScoreDataDisplayPage.line.forUser("Bernie").game(1).score).toBe(7);
    expect(lineScoreDataDisplayPage.line.forUser("Ada").game(2).score).toBe(9);
    expect(lineScoreDataDisplayPage.line.forUser("Bernie").game(2).score).toBe(11);
  });
});
