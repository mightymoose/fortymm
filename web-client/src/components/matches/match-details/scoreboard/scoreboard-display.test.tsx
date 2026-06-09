import { within } from "@/test/utilities";

import { buildScoreboardHeadingView } from "./heading.factory";
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
        outcome: "rita.kovac defeated leo.mertens, 3 games to 1",
      }),
    });

    const heading = scoreboardDisplayPage.getHeading();
    expect(heading).toHaveTextContent(
      "rita.kovac defeated leo.mertens, 3 games to 1",
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

  it("renders the children render-prop's output inside the region", () => {
    scoreboardDisplayPage.render({
      children: () => <p data-testid="scoreboard-body">live scores</p>,
    });

    const body = within(scoreboardDisplayPage.getContainer()).getByTestId(
      "scoreboard-body",
    );
    expect(body).toHaveTextContent("live scores");
  });

  it("invokes children with the exact scoreboard prop it was given", () => {
    const scoreboard = buildScoreboardView({ status: "live", outcome: "tied" });
    const children = vi.fn(() => null);

    scoreboardDisplayPage.render({ scoreboard, children });

    expect(children).toHaveBeenCalledWith(scoreboard);
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
