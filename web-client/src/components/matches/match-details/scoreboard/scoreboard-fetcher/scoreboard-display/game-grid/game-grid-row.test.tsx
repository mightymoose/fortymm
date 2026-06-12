import {
  buildScoredCellView,
  buildUnplayedCellView,
} from "./game-grid-row/game-grid-cell.factory";
import { buildGameGridRowView } from "./game-grid-row.factory";
import { gameGridRowPage } from "./game-grid-row.page";

describe("GameGridRow", () => {
  it("renders the player's name and initials avatar with a loss tone while behind", async () => {
    gameGridRowPage.render();

    expect(await gameGridRowPage.findPlayerName("left")).toHaveTextContent(
      "rita.kovac",
    );
    const avatar = gameGridRowPage.getAvatar("left");
    expect(avatar).toHaveTextContent("RK");
    expect(avatar).toHaveClass("md-avatar--loss");
  });

  it("renders the winner's avatar with the win tone", async () => {
    gameGridRowPage.render({ row: buildGameGridRowView({ won: true }) });

    await gameGridRowPage.findPlayerName("left");
    expect(gameGridRowPage.getAvatar("left")).toHaveClass("md-avatar--win");
  });

  it("renders a ghost row with the placeholder avatar and no initials", async () => {
    gameGridRowPage.render({
      row: buildGameGridRowView({
        name: "No opponent",
        initials: "NO",
        isGhost: true,
      }),
      rowSide: "right",
    });

    expect(await gameGridRowPage.findPlayerName("right")).toHaveTextContent(
      "No opponent",
    );
    // Ghost rows show the dashed placeholder, never the computed initials.
    const avatar = gameGridRowPage.getAvatar("right");
    expect(avatar).toHaveClass("md-avatar--ghost");
    expect(avatar).not.toHaveTextContent("NO");
  });

  it("renders a cell per game slot", async () => {
    gameGridRowPage.render({
      row: buildGameGridRowView({
        cells: [
          buildScoredCellView({ points: 11 }),
          buildUnplayedCellView(),
          buildUnplayedCellView(),
        ],
      }),
    });

    await gameGridRowPage.findPlayerName("left");
    expect(gameGridRowPage.getCell("left", 1)).toHaveTextContent("11");
    expect(gameGridRowPage.getCell("left", 3)).toHaveTextContent("—");
  });

  it("renders the SETS total, marking the winner's", async () => {
    gameGridRowPage.render({
      row: buildGameGridRowView({ won: true, gamesWon: 3 }),
    });

    await gameGridRowPage.findPlayerName("left");
    const total = gameGridRowPage.getTotal("left");
    expect(total).toHaveTextContent("3");
    expect(total).toHaveClass("md-games__total--win");
  });

  it("leaves the loser's SETS total unmarked", async () => {
    gameGridRowPage.render();

    await gameGridRowPage.findPlayerName("left");
    const total = gameGridRowPage.getTotal("left");
    expect(total).toHaveTextContent("1");
    expect(total).not.toHaveClass("md-games__total--win");
  });
});
