import { describe, it, expect } from "vitest";
import { HttpResponse, delay } from "msw";
import { matchDetails } from "@/test/factories";
import type { MatchDetails } from "@/api/matches";
import { scoreboardPage } from "./scoreboard.page";

type Side = MatchDetails["sides"][number];
type Game = MatchDetails["games"][number];

const side = (sideNumber: number, username: string): Side => ({
  side_number: sideNumber,
  players: [{ user_id: `u-${username}`, username, is_current_user: sideNumber === 1 }],
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

describe("Scoreboard", () => {
  it("renders the header strip and the line score from one match", async () => {
    const match = matchDetails({
      id: "m-board",
      status: "completed",
      best_of: 5,
      sides: [side(1, "ada"), side(2, "bo")],
      games: [
        scoredGame(1, 11, 4),
        scoredGame(2, 11, 6),
        scoredGame(3, 9, 11),
        scoredGame(4, 11, 8),
      ],
    });
    scoreboardPage.mockEndpoint(() => HttpResponse.json(match));
    scoreboardPage.render(match.id);
    await scoreboardPage.settle();

    // Header strip: final badge + sets tally.
    expect(scoreboardPage.header.meta.status).toBe("Final");
    expect(scoreboardPage.header.score.forPlayer("ada").score).toBe(3);
    expect(scoreboardPage.header.score.forPlayer("bo").score).toBe(1);

    // Line score: grid laid out for the best-of, with each side's per-game points.
    expect(scoreboardPage.lineScore.grid.columnLabels).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
    expect(scoreboardPage.lineScore.line.forUser("ada").game(1).score).toBe(11);
    expect(scoreboardPage.lineScore.line.forUser("bo").game(3).score).toBe(11);
  });

  it("shows both skeletons while the match loads, then swaps in both sections", async () => {
    const match = matchDetails({ id: "m-board-load", best_of: 5 });
    scoreboardPage.mockEndpoint(async () => {
      await delay(50);
      return HttpResponse.json(match);
    });

    scoreboardPage.render(match.id);

    // Each section renders its own skeleton until the request resolves.
    expect(scoreboardPage.headerSkeleton.isBusy).toBe(true);
    expect(scoreboardPage.lineScoreSkeleton.placeholderCount).toBeGreaterThan(0);

    // ...then both real sections take their place.
    await scoreboardPage.settle();
    expect(scoreboardPage.header.meta.status).toBe("Live · Game 1");
    expect(scoreboardPage.lineScore.grid.columnLabels).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
  });
});
