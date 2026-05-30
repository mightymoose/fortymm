import { describe, it, expect } from "vitest";
import { HttpResponse, delay } from "msw";
import { matchDetails } from "@/test/factories";
import type { MatchDetails } from "@/api/matches";
import { lineScoreDataPage } from "./line-score-data.page";

type Side = MatchDetails["sides"][number];
type Game = MatchDetails["games"][number];

// A participant side. Side 1 is the current user; pass `null` for a player-less
// (no-opponent sentinel) side.
const side = (sideNumber: number, username: string | null): Side => ({
  side_number: sideNumber,
  players:
    username === null
      ? []
      : [{ user_id: `u-${username}`, username, is_current_user: sideNumber === 1 }],
  games_won: 0,
  won: null,
  is_current_user_side: sideNumber === 1,
});

const scoredGame = (gameNumber: number, side1: number, side2: number): Game => ({
  id: `g-${gameNumber}`,
  game_number: gameNumber,
  score: {
    id: `s-${gameNumber}`,
    side_1_points: side1,
    side_2_points: side2,
    winner_side_number: side1 > side2 ? 1 : 2,
  },
});

const unscoredGame = (gameNumber: number): Game => ({
  id: `g-${gameNumber}`,
  game_number: gameNumber,
  score: null,
});

// Render a match through the real query + select transform and wait for the
// line score to paint.
async function show(match: MatchDetails) {
  lineScoreDataPage.mockEndpoint(() => HttpResponse.json(match));
  lineScoreDataPage.render(match.id);
  await lineScoreDataPage.settle();
}

describe("LineScoreData", () => {
  it("shows a loading placeholder until the match resolves", async () => {
    const match = matchDetails({
      id: "m-load",
      sides: [side(1, "ada"), side(2, "bo")],
      games: [scoredGame(1, 11, 3)],
    });
    lineScoreDataPage.mockEndpoint(async () => {
      await delay(50);
      return HttpResponse.json(match);
    });

    lineScoreDataPage.render(match.id);
    expect(lineScoreDataPage.isLoading).toBe(true);

    await lineScoreDataPage.settle();
    expect(lineScoreDataPage.isLoading).toBe(false);
  });

  it("renders a row per side with each side's per-game points", async () => {
    await show(
      matchDetails({
        id: "m-rows",
        sides: [side(1, "ada"), side(2, "bo")],
        games: [scoredGame(1, 11, 7), scoredGame(2, 9, 11)],
      }),
    );

    expect(lineScoreDataPage.line.forUser("ada").exists).toBe(true);
    expect(lineScoreDataPage.line.forUser("bo").exists).toBe(true);
    expect(lineScoreDataPage.line.forUser("ada").game(1).score).toBe(11);
    expect(lineScoreDataPage.line.forUser("bo").game(1).score).toBe(7);
    expect(lineScoreDataPage.line.forUser("ada").game(2).score).toBe(9);
    expect(lineScoreDataPage.line.forUser("bo").game(2).score).toBe(11);
  });

  it("lays the grid out for the match's best-of", async () => {
    await show(
      matchDetails({
        id: "m-bo7",
        best_of: 7,
        sides: [side(1, "ada"), side(2, "bo")],
        games: [scoredGame(1, 11, 4)],
      }),
    );

    expect(lineScoreDataPage.grid.columnLabels).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
    ]);
  });

  it("orders the sides by side_number regardless of API order", async () => {
    await show(
      matchDetails({
        id: "m-order",
        // Returned out of order: side 2 first.
        sides: [side(2, "bo"), side(1, "ada")],
        games: [scoredGame(1, 11, 3)],
      }),
    );

    // Side 1 (ada) maps to side_1_points, side 2 (bo) to side_2_points, even
    // though the API returned them reversed.
    expect(lineScoreDataPage.line.forUser("ada").game(1).score).toBe(11);
    expect(lineScoreDataPage.line.forUser("bo").game(1).score).toBe(3);
  });

  it("maps side 1 points left, side 2 points right, and drops unscored games", async () => {
    await show(
      matchDetails({
        id: "m-tally",
        best_of: 5,
        sides: [side(1, "ada"), side(2, "bo")],
        games: [scoredGame(1, 5, 11), unscoredGame(2)],
      }),
    );

    expect(lineScoreDataPage.line.forUser("ada").game(1).score).toBe(5);
    expect(lineScoreDataPage.line.forUser("bo").game(1).score).toBe(11);
    // The unscored game 2 was dropped, so it renders as an empty cell rather
    // than a scored one.
    expect(lineScoreDataPage.line.forUser("ada").game(2).exists).toBe(false);
  });

  it("renders a player-less side as the No opponent placeholder", async () => {
    await show(
      matchDetails({
        id: "m-solo",
        sides: [side(1, "ada"), side(2, null)],
        games: [scoredGame(1, 11, 3)],
      }),
    );

    expect(lineScoreDataPage.line.forUser("ada").exists).toBe(true);
    expect(lineScoreDataPage.line.forUser("No opponent").exists).toBe(true);
  });
});
