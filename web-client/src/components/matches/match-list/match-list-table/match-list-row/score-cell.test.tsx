import { buildScoreCellView } from "./score-cell.factory";
import { scoreCellPage } from "./score-cell.page";

describe("ScoreCell", () => {
  it("renders the games score string with the score-cell games classes", () => {
    scoreCellPage.render({ score: buildScoreCellView({ games: "3–0" }) });

    const games = scoreCellPage.getGamesScore();
    expect(games).toHaveTextContent("3–0");
    expect(games).toHaveClass("score-cell", "games");
  });

  it("renders an em-dash with the pending class when games is null", () => {
    scoreCellPage.render({ score: buildScoreCellView({ games: null }) });

    const pending = scoreCellPage.getPendingScore();
    expect(pending).toHaveTextContent("—");
    expect(pending).toHaveClass("score-cell", "pending");
    expect(scoreCellPage.queryGames()).toBeNull();
  });
});
