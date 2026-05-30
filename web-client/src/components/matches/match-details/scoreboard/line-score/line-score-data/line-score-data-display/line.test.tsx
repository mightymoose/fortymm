import { describe, it, expect } from "vitest";
import { linePage } from "./line.page";
import { lineSideFactory, game, gameWonBy, lineFactory } from "./line.factory";

describe("Line", () => {
  const sides = [
    lineSideFactory({ username: "Ada" }),
    lineSideFactory({ username: "Bernie" }),
  ];

  it("labels the row with its side's participant", () => {
    linePage.render(lineFactory({ sides, side: sides[0] }));

    expect(linePage.forUser("Ada").exists).toBe(true);
  });

  it("shows this side's points for each played game", () => {
    linePage.render(
      lineFactory({ sides, side: sides[0], games: [game(11, 7), game(9, 11)] }),
    );

    expect(linePage.forUser("Ada").game(1).score).toBe(11);
    expect(linePage.forUser("Ada").game(2).score).toBe(9);
  });

  it("shows the opponent's points when rendering the opponent's row", () => {
    linePage.render(
      lineFactory({ sides, side: sides[1], games: [game(11, 7), game(9, 11)] }),
    );

    expect(linePage.forUser("Bernie").game(1).score).toBe(7);
    expect(linePage.forUser("Bernie").game(2).score).toBe(11);
  });

  it("marks the games this side won and leaves the rest unmarked", () => {
    linePage.render(
      lineFactory({ sides, side: sides[0], games: [game(11, 7), game(9, 11)] }),
    );

    expect(linePage.forUser("Ada").game(1).won).toBe(true);
    expect(linePage.forUser("Ada").game(2).won).toBe(false);
  });

  it("pads to best-of with empty cells for games not yet played", () => {
    linePage.render(
      lineFactory({ sides, side: sides[0], games: [game(11, 7)], bestOf: 5 }),
    );

    expect(linePage.cellCount).toBe(5);
    expect(linePage.emptyCellCount).toBe(4);
    // The not-yet-played slots carry no labelled score cell.
    expect(linePage.forUser("Ada").game(2).exists).toBe(false);
  });

  it("flags the side that has clinched the match as the winner", () => {
    linePage.render(
      lineFactory({
        sides,
        side: sides[0],
        games: [gameWonBy(0), gameWonBy(0)],
        bestOf: 3,
      }),
    );

    expect(linePage.forUser("Ada").won).toBe(true);
  });

  it("does not flag a side that has not yet clinched the match", () => {
    linePage.render(
      lineFactory({
        sides,
        side: sides[0],
        games: [gameWonBy(0), gameWonBy(1)],
        bestOf: 5,
      }),
    );

    expect(linePage.forUser("Ada").won).toBe(false);
  });

  it("renders a player-less side as the No opponent placeholder", () => {
    const ghostSides = [lineSideFactory({ username: "Ada" }), lineSideFactory({ username: "" })];
    linePage.render(lineFactory({ sides: ghostSides, side: ghostSides[1] }));

    expect(linePage.forUser("No opponent").exists).toBe(true);
  });
});
