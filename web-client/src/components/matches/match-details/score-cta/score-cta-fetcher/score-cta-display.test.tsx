import { buildScoreCtaView } from "./score-cta-display.factory";
import { scoreCtaDisplayPage } from "./score-cta-display.page";

describe("ScoreCtaDisplay", () => {
  it("links the Score button to the score-entry route for the current game", async () => {
    scoreCtaDisplayPage.render({
      scoreCta: buildScoreCtaView({ matchId: "m-7", gameNumber: 3 }),
    });

    const link = await scoreCtaDisplayPage.findScoreLink();
    expect(link).toHaveAttribute("href", "/matches/m-7/games/3/scores/new");
    expect(link).toHaveClass("md-btn--primary");
  });
});
