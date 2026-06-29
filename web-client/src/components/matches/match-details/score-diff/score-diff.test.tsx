import {
  buildNegotiationDiffEntry,
  buildNegotiationGame,
} from "./score-diff.factory";
import { scoreDiffPage } from "./score-diff.page";

describe("ScoreDiff", () => {
  it("renders a row per diff entry, keyed by game number", () => {
    scoreDiffPage.render({
      diff: [
        buildNegotiationDiffEntry({ game_number: 2 }),
        buildNegotiationDiffEntry({ game_number: 4 }),
      ],
    });

    expect(scoreDiffPage.getEntry(2)).toBeInTheDocument();
    expect(scoreDiffPage.getEntry(4)).toBeInTheDocument();
  });

  it("strikes through the old score and emphasizes the new for a changed game", () => {
    scoreDiffPage.render({
      diff: [
        buildNegotiationDiffEntry({
          game_number: 1,
          old: buildNegotiationGame({
            game_number: 1,
            side_1_points: 11,
            side_2_points: 9,
          }),
          new: buildNegotiationGame({
            game_number: 1,
            side_1_points: 9,
            side_2_points: 11,
          }),
        }),
      ],
    });

    const old = scoreDiffPage.queryOld(1);
    expect(old).toHaveTextContent("11–9");
    expect(old).toHaveClass("line-through");
    expect(scoreDiffPage.getNew(1)).toHaveTextContent("9–11");
    // A changed game carries no "new game" tag.
    expect(scoreDiffPage.queryAddedTag(1)).not.toBeInTheDocument();
  });

  it("renders an added game (old === null) without a strikethrough", () => {
    scoreDiffPage.render({
      diff: [
        buildNegotiationDiffEntry({
          game_number: 5,
          old: null,
          new: buildNegotiationGame({
            game_number: 5,
            side_1_points: 11,
            side_2_points: 8,
          }),
        }),
      ],
    });

    // No old/struck-through score for an added game.
    expect(scoreDiffPage.queryOld(5)).not.toBeInTheDocument();
    expect(scoreDiffPage.getNew(5)).toHaveTextContent("11–8");
    expect(scoreDiffPage.queryAddedTag(5)).toBeInTheDocument();
  });

  it("renders a multi-game diff mixing a changed game and an added game", () => {
    scoreDiffPage.render({
      diff: [
        buildNegotiationDiffEntry({
          game_number: 2,
          old: buildNegotiationGame({
            game_number: 2,
            side_1_points: 8,
            side_2_points: 11,
          }),
          new: buildNegotiationGame({
            game_number: 2,
            side_1_points: 11,
            side_2_points: 8,
          }),
        }),
        buildNegotiationDiffEntry({
          game_number: 3,
          old: null,
          new: buildNegotiationGame({
            game_number: 3,
            side_1_points: 11,
            side_2_points: 6,
          }),
        }),
      ],
    });

    // Changed game 2: old struck through, new emphasized, no added tag.
    expect(scoreDiffPage.queryOld(2)).toHaveTextContent("8–11");
    expect(scoreDiffPage.getNew(2)).toHaveTextContent("11–8");
    expect(scoreDiffPage.queryAddedTag(2)).not.toBeInTheDocument();

    // Added game 3: no old score, new emphasized, carries the added tag.
    expect(scoreDiffPage.queryOld(3)).not.toBeInTheDocument();
    expect(scoreDiffPage.getNew(3)).toHaveTextContent("11–6");
    expect(scoreDiffPage.queryAddedTag(3)).toBeInTheDocument();
  });
});
