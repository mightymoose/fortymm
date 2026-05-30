import { describe, it, expect } from "vitest";
import { HttpResponse, delay } from "msw";
import { matchDetails } from "@/test/factories";
import type { MatchDetails } from "@/api/matches";
import { headerDataPage } from "./header-data.page";

type Side = MatchDetails["sides"][number];
type Game = MatchDetails["games"][number];

// A participant side. side 1 is the current user; pass `null` for a player-less
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
// header strip to paint.
async function show(match: MatchDetails) {
  headerDataPage.mockEndpoint(() => HttpResponse.json(match));
  headerDataPage.render(match.id);
  await headerDataPage.settle();
}

describe("HeaderData", () => {
  it("shows a loading placeholder until the match resolves", async () => {
    const match = matchDetails({
      id: "m-load",
      status: "completed",
      sides: [side(1, "ada"), side(2, "bo")],
      games: [scoredGame(1, 11, 3)],
    });
    headerDataPage.mockEndpoint(async () => {
      await delay(50);
      return HttpResponse.json(match);
    });

    headerDataPage.render(match.id);
    expect(headerDataPage.isLoading).toBe(true);

    await headerDataPage.settle();
    expect(headerDataPage.isLoading).toBe(false);
  });

  it("maps an in-progress match to the live badge with its game number", async () => {
    await show(
      matchDetails({
        id: "m-live",
        status: "in_progress",
        current_game: { game_number: 3 },
        best_of: 5,
        sides: [side(1, "ada"), side(2, "bo")],
        games: [scoredGame(1, 11, 7), scoredGame(2, 5, 11)],
      }),
    );

    expect(headerDataPage.meta.status).toBe("Live · Game 3");
    expect(headerDataPage.meta.format).toBe("SINGLES · BO5");
    expect(headerDataPage.meta.firstTo).toBe(3);
    expect(headerDataPage.score.forPlayer("ada").score).toBe(1);
    expect(headerDataPage.score.forPlayer("bo").score).toBe(1);
  });

  it("maps an in-progress match with no current game to awaiting confirmation", async () => {
    await show(
      matchDetails({
        id: "m-await",
        status: "in_progress",
        current_game: null,
        sides: [side(1, "ada"), side(2, "bo")],
        games: [scoredGame(1, 11, 4), scoredGame(2, 11, 6)],
      }),
    );

    expect(headerDataPage.meta.status).toBe("Awaiting confirmation");
  });

  it("maps a pending match to the upcoming badge with a VS scoreline", async () => {
    await show(
      matchDetails({
        id: "m-pending",
        status: "pending",
        status_label: "Sat 10am",
        current_game: { game_number: 1 },
        sides: [side(1, "ada"), side(2, "bo")],
        games: [],
      }),
    );

    expect(headerDataPage.meta.status).toBe("Upcoming");
    // No games played yet, so the meta strip hides "first to N"...
    expect(headerDataPage.meta.firstTo).toBeNull();
    // ...and the score shows "VS" rather than a tally.
    expect(headerDataPage.score.hasVersusLabel()).toBe(true);
    expect(headerDataPage.score.playerOrder).toEqual(["ada", "bo"]);
  });

  it("maps a completed match to the final badge and flags the clincher", async () => {
    await show(
      matchDetails({
        id: "m-final",
        status: "completed",
        best_of: 5,
        sides: [side(1, "ada"), side(2, "bo")],
        games: [
          scoredGame(1, 11, 4),
          scoredGame(2, 11, 6),
          scoredGame(3, 9, 11),
          scoredGame(4, 11, 8),
        ],
      }),
    );

    expect(headerDataPage.meta.status).toBe("Final");
    expect(headerDataPage.score.forPlayer("ada").score).toBe(3);
    expect(headerDataPage.score.forPlayer("ada").won).toBe(true);
    expect(headerDataPage.score.forPlayer("bo").score).toBe(1);
    expect(headerDataPage.score.forPlayer("bo").won).toBe(false);
  });

  it.each(["disputed", "voided"] as const)(
    "maps a %s match to the final badge",
    async (status) => {
      await show(
        matchDetails({
          id: `m-${status}`,
          status,
          sides: [side(1, "ada"), side(2, "bo")],
          games: [scoredGame(1, 11, 4), scoredGame(2, 4, 11)],
        }),
      );

      expect(headerDataPage.meta.status).toBe("Final");
    },
  );

  it("orders the sides by side_number regardless of API order", async () => {
    await show(
      matchDetails({
        id: "m-order",
        status: "in_progress",
        current_game: { game_number: 2 },
        // Returned out of order: side 2 first.
        sides: [side(2, "bo"), side(1, "ada")],
        games: [scoredGame(1, 11, 3)],
      }),
    );

    expect(headerDataPage.score.playerOrder).toEqual(["ada", "bo"]);
    // Side 1 (ada) took game 1, so the tally tracks the sorted sides too.
    expect(headerDataPage.score.forPlayer("ada").score).toBe(1);
    expect(headerDataPage.score.forPlayer("bo").score).toBe(0);
  });

  it("maps side 1 points left, side 2 points right, and drops unscored games", async () => {
    await show(
      matchDetails({
        id: "m-tally",
        status: "in_progress",
        current_game: { game_number: 4 },
        sides: [side(1, "ada"), side(2, "bo")],
        // bo (side 2) takes games 1-2, ada (side 1) takes game 3, game 4 unscored.
        games: [
          scoredGame(1, 5, 11),
          scoredGame(2, 3, 11),
          scoredGame(3, 11, 9),
          unscoredGame(4),
        ],
      }),
    );

    // ada === 1 (not 2) proves the unscored game 4 was dropped rather than
    // counted as a side-1 win.
    expect(headerDataPage.score.forPlayer("ada").score).toBe(1);
    expect(headerDataPage.score.forPlayer("bo").score).toBe(2);
  });

  it("renders a player-less side as the No opponent placeholder", async () => {
    await show(
      matchDetails({
        id: "m-solo",
        status: "in_progress",
        current_game: { game_number: 2 },
        sides: [side(1, "ada"), side(2, null)],
        games: [scoredGame(1, 11, 3)],
      }),
    );

    expect(headerDataPage.score.playerOrder).toEqual(["ada", "No opponent"]);
  });

  it("passes best_of through to the format and first-to labels", async () => {
    await show(
      matchDetails({
        id: "m-bo7",
        status: "completed",
        best_of: 7,
        sides: [side(1, "ada"), side(2, "bo")],
        games: [scoredGame(1, 11, 4)],
      }),
    );

    expect(headerDataPage.meta.format).toBe("SINGLES · BO7");
    expect(headerDataPage.meta.firstTo).toBe(4);
  });
});
