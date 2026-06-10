import {
  buildCareerStatsView,
  buildRookieCareerStatsView,
} from "./career-stats.factory";
import { careerStatsPage } from "./career-stats.page";

describe("CareerStats", () => {
  it("shows the career match count", () => {
    careerStatsPage.render({ career: buildCareerStatsView({ matches: 12 }) });

    expect(careerStatsPage.getCareerMatches()).toHaveTextContent("12");
  });

  it("highlights a 50%+ win rate in the good tone", () => {
    careerStatsPage.render({
      career: buildCareerStatsView({ winRateLabel: "75%", highWinRate: true }),
    });

    const winRate = careerStatsPage.getWinRate();
    expect(winRate).toHaveTextContent("75%");
    expect(winRate).toHaveClass("md-profile__career-value--good");
  });

  it("leaves a sub-50% win rate untinted", () => {
    careerStatsPage.render({
      career: buildCareerStatsView({ winRateLabel: "40%", highWinRate: false }),
    });

    const winRate = careerStatsPage.getWinRate();
    expect(winRate).toHaveTextContent("40%");
    expect(winRate).not.toHaveClass("md-profile__career-value--good");
  });

  it("dims an em dash for a rookie with no win rate yet", () => {
    careerStatsPage.render({ career: buildRookieCareerStatsView() });

    expect(careerStatsPage.getCareerMatches()).toHaveTextContent("0");
    const winRate = careerStatsPage.getWinRate();
    expect(winRate).toHaveTextContent("—");
    expect(winRate.querySelector(".dim")).not.toBeNull();
  });
});
