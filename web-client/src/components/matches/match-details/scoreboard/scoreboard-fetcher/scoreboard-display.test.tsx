import { buildGameGridView } from "./scoreboard-display/game-grid.factory";
import { buildHeroRowView } from "./scoreboard-display/hero-row.factory";
import { buildHeroSideView } from "./scoreboard-display/hero-row/hero-player.factory";
import { buildScoreboardHeadingView } from "./scoreboard-display/heading.factory";
import { buildScoreboardView } from "./scoreboard-display.factory";
import { scoreboardDisplayPage } from "./scoreboard-display.page";

describe("ScoreboardDisplay", () => {
  it("renders an md-hero region landmark", () => {
    scoreboardDisplayPage.render();

    expect(scoreboardDisplayPage.getContainer()).toHaveClass("md-hero");
  });

  it("names the heading with the outcome when one is provided", () => {
    scoreboardDisplayPage.render({
      scoreboard: buildScoreboardView({
        outcome: "rita.kovac defeated leo.mertens by 3 games to 1",
      }),
    });

    const heading = scoreboardDisplayPage.getHeading();
    expect(heading).toHaveTextContent(
      "rita.kovac defeated leo.mertens by 3 games to 1",
    );
    expect(heading).toHaveClass("sr-only");
  });

  it('falls back to "Match" when the outcome is null', () => {
    scoreboardDisplayPage.render({
      scoreboard: buildScoreboardView({ outcome: null }),
    });

    expect(scoreboardDisplayPage.getHeading()).toHaveTextContent("Match");
  });

  it("renders the heading strip inside the region from the view's heading", () => {
    scoreboardDisplayPage.render({
      scoreboard: buildScoreboardView({
        heading: buildScoreboardHeadingView({
          chip: { status: "final", label: "Final" },
          formatLabel: "SINGLES · BO5",
          raceLabel: "First to 3",
        }),
      }),
    });

    const strip = scoreboardDisplayPage.headingStrip;
    expect(strip.getChip()).toHaveTextContent("Final");
    expect(strip.getFormatLabel()).toHaveTextContent("SINGLES · BO5");
    expect(strip.getRaceLabel()).toHaveTextContent("First to 3");
    expect(scoreboardDisplayPage.getContainer()).toContainElement(
      strip.getChip(),
    );
  });

  it("renders the hero row inside the region from the view's heroRow", () => {
    // Wiring only: row content is pinned by the query and hero-row tests.
    scoreboardDisplayPage.render({
      scoreboard: buildScoreboardView({
        heroRow: buildHeroRowView({
          left: buildHeroSideView({ name: "rita.kovac" }),
        }),
      }),
    });

    const name = scoreboardDisplayPage.heroRow.getPlayerName(
      "l",
      "rita.kovac",
    );
    expect(scoreboardDisplayPage.getContainer()).toContainElement(name);
  });

  it("renders the game grid inside the region from the view's gameGrid", () => {
    // Wiring only: grid content is pinned by the query and game-grid tests.
    scoreboardDisplayPage.render({
      scoreboard: buildScoreboardView({ gameGrid: buildGameGridView() }),
    });

    const grid = scoreboardDisplayPage.gameGrid.getGrid();
    expect(scoreboardDisplayPage.getContainer()).toContainElement(grid);
    expect(
      scoreboardDisplayPage.gameGrid.getPlayerName("left"),
    ).toHaveTextContent("rita.kovac");
  });

  it("omits the game grid when the view's gameGrid is null", () => {
    scoreboardDisplayPage.render({
      scoreboard: buildScoreboardView({ gameGrid: null }),
    });

    expect(scoreboardDisplayPage.gameGrid.queryGrid()).not.toBeInTheDocument();
  });

  it("labels the region via useId, pointing aria-labelledby at the heading id", () => {
    scoreboardDisplayPage.render();

    const id = scoreboardDisplayPage.getHeading().getAttribute("id");
    expect(id).toBeTruthy();
    expect(scoreboardDisplayPage.getContainer()).toHaveAttribute(
      "aria-labelledby",
      id,
    );
  });
});
