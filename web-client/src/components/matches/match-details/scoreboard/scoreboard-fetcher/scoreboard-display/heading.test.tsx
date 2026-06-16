import { buildScoreboardHeadingView } from "./heading.factory";
import { headingPage } from "./heading.page";

describe("Heading", () => {
  it("renders the status chip from the heading view's chip", () => {
    // Chip variants are covered by the StatusChip tests; this pins the
    // composition only.
    headingPage.render({
      heading: buildScoreboardHeadingView({
        chip: { status: "final", label: "Final" },
      }),
    });

    expect(headingPage.getChip()).toHaveTextContent("Final");
  });

  it("renders the format label", () => {
    headingPage.render({
      heading: buildScoreboardHeadingView({ formatLabel: "DOUBLES · BO3" }),
    });

    expect(headingPage.getFormatLabel()).toHaveTextContent("DOUBLES · BO3");
  });

  it("renders the race label when one is provided", () => {
    headingPage.render({
      heading: buildScoreboardHeadingView({ raceLabel: "First to 2" }),
    });

    expect(headingPage.getRaceLabel()).toHaveTextContent("First to 2");
  });

  it("omits the race label when raceLabel is null", () => {
    headingPage.render({
      heading: buildScoreboardHeadingView({ raceLabel: null }),
    });

    expect(headingPage.queryRaceLabel()).not.toBeInTheDocument();
  });
});
