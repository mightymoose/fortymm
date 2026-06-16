import {
  buildScoredCellView,
  buildUnplayedCellView,
} from "./game-grid/game-grid-row/game-grid-cell.factory";
import { buildGameGridRowView } from "./game-grid/game-grid-row.factory";
import { buildGameGridView } from "./game-grid.factory";
import { gameGridPage } from "./game-grid.page";

describe("GameGrid", () => {
  it("renders a column label per game slot plus the SETS column", async () => {
    gameGridPage.render({
      gameGrid: buildGameGridView({
        bestOf: 3,
        rows: [
          buildGameGridRowView({
            cells: [
              buildScoredCellView(),
              buildUnplayedCellView(),
              buildUnplayedCellView(),
            ],
          }),
          buildGameGridRowView({
            name: "leo.mertens",
            initials: "LM",
            cells: [
              buildScoredCellView({ points: 7, won: false }),
              buildUnplayedCellView(),
              buildUnplayedCellView(),
            ],
          }),
        ],
      }),
    });

    const grid = await gameGridPage.findGrid();
    expect(grid).toHaveTextContent("GAMES");
    expect(grid).toHaveTextContent("G1");
    expect(grid).toHaveTextContent("G3");
    expect(grid).not.toHaveTextContent("G4");
    expect(grid).toHaveTextContent("SETS");
  });

  it("renders both rows' player names, viewer first", async () => {
    gameGridPage.render();

    await gameGridPage.findGrid();
    expect(gameGridPage.getPlayerName("left")).toHaveTextContent("rita.kovac");
    expect(gameGridPage.getPlayerName("right")).toHaveTextContent(
      "leo.mertens",
    );
  });

  it("renders all 7 game labels plus SETS for a BO7, inside the scroll container", async () => {
    // Regression for #509: on a BO7 the columns can't shrink to fit a narrow
    // viewport, so the trailing SETS column was clipped off-screen by the
    // hero's `overflow: hidden`. The fix puts the grid track inside a
    // horizontally scrollable `.md-games` boundary (the testid host) so every
    // column — including SETS — stays in the DOM and reachable by scroll.
    gameGridPage.render({
      gameGrid: buildGameGridView({
        bestOf: 7,
        rows: [
          buildGameGridRowView({
            cells: Array.from({ length: 7 }, () => buildUnplayedCellView()),
          }),
          buildGameGridRowView({
            name: "leo.mertens",
            initials: "LM",
            cells: Array.from({ length: 7 }, () => buildUnplayedCellView()),
          }),
        ],
      }),
    });

    const grid = await gameGridPage.findGrid();
    for (let g = 1; g <= 7; g += 1) {
      expect(grid).toHaveTextContent(`G${g}`);
    }
    expect(grid).toHaveTextContent("SETS");

    // The column track must live inside the `.md-games` scroll boundary so the
    // overflow is scrollable rather than clipped by the hero section.
    const track = gameGridPage.getGridTrack();
    expect(track).not.toBeNull();
    expect(grid).toContainElement(track);
  });

  it("renders each row's cells and SETS total against the shared match id", async () => {
    gameGridPage.render({
      gameGrid: buildGameGridView({
        matchId: "m-42",
        rows: [
          buildGameGridRowView({
            cells: [
              buildScoredCellView({ points: 11, editGameNumber: 1 }),
              buildUnplayedCellView({ isLive: true }),
              buildUnplayedCellView(),
              buildUnplayedCellView(),
              buildUnplayedCellView(),
            ],
          }),
          buildGameGridRowView({ name: "leo.mertens", gamesWon: 0 }),
        ],
      }),
    });

    await gameGridPage.findGrid();
    // The viewer's editable cell resolves its link against the grid's matchId.
    expect(gameGridPage.getCell("left", 1)).toHaveAttribute(
      "href",
      "/matches/m-42/games/1/scores/edit",
    );
    expect(gameGridPage.getCell("right", 1)).toHaveTextContent("11");
    expect(gameGridPage.getTotal("left")).toHaveTextContent("1");
    expect(gameGridPage.getTotal("right")).toHaveTextContent("0");
  });
});
