import {
  buildScoredCellView,
  buildUnplayedCellView,
} from "./game-grid-cell.factory";
import { gameGridCellPage } from "./game-grid-cell.page";

describe("GameGridCell", () => {
  it("renders a winning scored cell with its points and the win tone", async () => {
    gameGridCellPage.render({
      cell: buildScoredCellView({ points: 11, won: true }),
    });

    const cell = await gameGridCellPage.findCell("left", 1);
    expect(cell).toHaveTextContent("11");
    expect(cell).toHaveClass("md-games__cell--win");
  });

  it("renders a losing scored cell with the loss tone", async () => {
    gameGridCellPage.render({
      cell: buildScoredCellView({ points: 4, won: false }),
    });

    const cell = await gameGridCellPage.findCell("left", 1);
    expect(cell).toHaveTextContent("4");
    expect(cell).toHaveClass("md-games__cell--loss");
  });

  it("renders an unplayed cell as an em-dash", async () => {
    gameGridCellPage.render({ cell: buildUnplayedCellView() });

    const cell = await gameGridCellPage.findCell("left", 1);
    expect(cell).toHaveTextContent("—");
    expect(cell).not.toHaveClass("md-games__cell--live");
  });

  it("highlights the live unplayed cell", async () => {
    gameGridCellPage.render({ cell: buildUnplayedCellView({ isLive: true }) });

    const cell = await gameGridCellPage.findCell("left", 1);
    expect(cell).toHaveClass("md-games__cell--live");
  });

  it("links an editable scored cell to that game's scores/edit route", async () => {
    gameGridCellPage.render({
      cell: buildScoredCellView({ points: 11, editGameNumber: 1 }),
      matchId: "m-42",
    });

    const cell = await gameGridCellPage.findCell("left", 1);
    expect(cell).toHaveRole("link");
    expect(cell).toHaveAttribute("href", "/matches/m-42/games/1/scores/edit");
  });

  it("renders a non-editable scored cell as a plain div, not a link", async () => {
    gameGridCellPage.render();

    const cell = await gameGridCellPage.findCell("left", 1);
    expect(cell).not.toHaveRole("link");
  });

  it("keys its testid off the row side and game number", async () => {
    gameGridCellPage.render({ rowSide: "right", gameNumber: 3 });

    const cell = await gameGridCellPage.findCell("right", 3);
    expect(cell).toBeInTheDocument();
  });
});
