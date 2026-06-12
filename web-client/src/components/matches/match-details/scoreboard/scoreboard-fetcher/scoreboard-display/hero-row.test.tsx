import {
  buildGhostHeroSideView,
  buildHeroSideView,
} from "./hero-row/hero-player.factory";
import { buildUpcomingHeroScoreView } from "./hero-row/hero-score.factory";
import { buildHeroRowView } from "./hero-row.factory";
import { heroRowPage } from "./hero-row.page";

// Wiring only: side and score-block content is pinned by the hero-player and
// hero-score tests.
describe("HeroRow", () => {
  it("renders the left side on the left and the right side on the right", () => {
    heroRowPage.render({
      heroRow: buildHeroRowView({
        left: buildHeroSideView({ name: "rita.kovac" }),
        right: buildHeroSideView({ name: "leo.mertens", initials: "LM" }),
      }),
    });

    expect(heroRowPage.getPlayerName("l", "rita.kovac")).toBeInTheDocument();
    expect(heroRowPage.getPlayerName("r", "leo.mertens")).toBeInTheDocument();
  });

  it("renders the score block between the sides from the view's score", () => {
    heroRowPage.render();

    expect(heroRowPage.getScore("l")).toHaveTextContent("2");
    expect(heroRowPage.getScore("r")).toHaveTextContent("1");
  });

  it("renders the VS placeholder when the view's score is upcoming", () => {
    heroRowPage.render({
      heroRow: buildHeroRowView({ score: buildUpcomingHeroScoreView() }),
    });

    expect(heroRowPage.getVsLabel()).toBeInTheDocument();
  });

  it("renders a ghost right side as the No-opponent placeholder", () => {
    heroRowPage.render({
      heroRow: buildHeroRowView({ right: buildGhostHeroSideView() }),
    });

    expect(heroRowPage.getPlayerName("r", "No opponent")).toBeInTheDocument();
  });
});
