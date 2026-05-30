import { screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { lineScoreGridPage } from "./line-score-grid.page";

describe("LineScoreGrid", () => {
  it("labels each game column G1…GN for the match's best-of", () => {
    lineScoreGridPage.render({ bestOf: 5, children: null });

    expect(lineScoreGridPage.columnLabels).toEqual(["G1", "G2", "G3", "G4", "G5"]);
  });

  it("reserves the columns without labels while the game count is unknown", () => {
    lineScoreGridPage.render({ bestOf: 3, showGameLabels: false, children: null });

    // The placeholder columns still render so the rows don't reflow into the
    // header row, but blank — we can't know the labels are right yet.
    expect(lineScoreGridPage.columnLabels).toEqual(["", "", ""]);
  });

  it("renders the GAMES kicker", () => {
    lineScoreGridPage.render({ bestOf: 3, children: null });

    expect(lineScoreGridPage.hasKicker).toBe(true);
  });

  it("groups the grid for assistive tech", () => {
    lineScoreGridPage.render({ bestOf: 3, children: null });

    expect(lineScoreGridPage.group).not.toBeNull();
  });

  it("renders the supplied rows as children", () => {
    lineScoreGridPage.render({ bestOf: 3, children: <div>row content</div> });

    expect(screen.getByText("row content")).not.toBeNull();
  });
});
