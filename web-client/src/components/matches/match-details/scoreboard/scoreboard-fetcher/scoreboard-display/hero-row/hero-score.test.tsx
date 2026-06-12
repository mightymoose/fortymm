import {
  buildScorelineHeroScoreView,
  buildUpcomingHeroScoreView,
} from "./hero-score.factory";
import { heroScorePage } from "./hero-score.page";

describe("HeroScore", () => {
  it("shows each side's games won in the scoreline", () => {
    heroScorePage.render({
      score: buildScorelineHeroScoreView({
        left: { gamesWon: 3, won: false },
        right: { gamesWon: 1, won: false },
      }),
    });

    expect(heroScorePage.getScore("l")).toHaveTextContent("3");
    expect(heroScorePage.getScore("r")).toHaveTextContent("1");
    expect(heroScorePage.queryVsLabel()).not.toBeInTheDocument();
  });

  it("highlights the left score when the left side won", () => {
    heroScorePage.render({
      score: buildScorelineHeroScoreView({
        left: { gamesWon: 3, won: true },
        right: { gamesWon: 1, won: false },
      }),
    });

    expect(heroScorePage.getScore("l")).toHaveClass("md-hero__score--win");
    expect(heroScorePage.getScore("r")).not.toHaveClass(
      "md-hero__score--win",
    );
  });

  it("highlights the right score when the right side won", () => {
    heroScorePage.render({
      score: buildScorelineHeroScoreView({
        left: { gamesWon: 1, won: false },
        right: { gamesWon: 3, won: true },
      }),
    });

    expect(heroScorePage.getScore("r")).toHaveClass("md-hero__score--win");
    expect(heroScorePage.getScore("l")).not.toHaveClass(
      "md-hero__score--win",
    );
  });

  it("shows the VS placeholder with the status label before the match starts", () => {
    heroScorePage.render({
      score: buildUpcomingHeroScoreView({ statusLabel: "Awaiting opponent" }),
    });

    expect(heroScorePage.getVsLabel()).toBeInTheDocument();
    expect(
      heroScorePage.getVsStatusLabel("Awaiting opponent"),
    ).toBeInTheDocument();
    expect(heroScorePage.queryScore("l")).not.toBeInTheDocument();
    expect(heroScorePage.queryScore("r")).not.toBeInTheDocument();
  });
});
