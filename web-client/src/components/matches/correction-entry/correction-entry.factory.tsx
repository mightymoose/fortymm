import type { components } from "@/api/schema";

import {
  buildMatchDetails,
  buildMatchDetailsSide,
  buildMatchDetailsPlayer,
  type MatchDetails,
} from "@/mocks/factories/matches/match-details.factory";

type NegotiationGame = components["schemas"]["NegotiationGame"];
type NegotiationResult = components["schemas"]["NegotiationResult"];

export const STANDING_RESULT_ID = "11110000-0000-4000-8000-000000000000";

/** One game inside a standing-result snapshot. */
export function buildStandingGame(
  overrides: Partial<NegotiationGame> = {},
): NegotiationGame {
  return {
    game_number: 1,
    side_1_points: 11,
    side_2_points: 8,
    ...overrides,
  };
}

/**
 * A standing result the viewer can correct — the opponent's 3–0 proposal
 * (best-of-5), submitted by the opponent. Games are the immutable snapshot the
 * correction screen pre-fills from.
 */
export function buildStandingResult(
  overrides: Partial<NegotiationResult> = {},
): NegotiationResult {
  return {
    id: STANDING_RESULT_ID,
    games: [
      buildStandingGame({
        game_number: 1,
        side_1_points: 11,
        side_2_points: 8,
      }),
      buildStandingGame({
        game_number: 2,
        side_1_points: 11,
        side_2_points: 6,
      }),
      buildStandingGame({
        game_number: 3,
        side_1_points: 11,
        side_2_points: 9,
      }),
    ],
    submitted_by: "leo.mertens",
    submitted_at: "2026-06-08T13:00:00Z",
    ...overrides,
  };
}

/**
 * A `MatchDetails` in the `review` state: the viewer (side 1, `rita.kovac`)
 * faces the opponent's standing proposal and can suggest a correction. Pass
 * `standing` to reshape the proposed board.
 */
export function buildCorrectableMatch(
  overrides: Partial<MatchDetails> = {},
): MatchDetails {
  const standing = buildStandingResult();
  return buildMatchDetails({
    id: "m-correct-1",
    status: "in_progress",
    status_label: "Live",
    best_of: 5,
    games_to_win: 3,
    affects_rating: true,
    sides: [
      buildMatchDetailsSide({ side_number: 1, games_won: 0 }),
      buildMatchDetailsSide({
        side_number: 2,
        players: [
          buildMatchDetailsPlayer({
            user_id: "u-opponent",
            username: "leo.mertens",
            is_current_user: false,
          }),
        ],
        games_won: 3,
        is_current_user_side: false,
      }),
    ],
    current_game: null,
    negotiation: {
      viewer_state: "review",
      your_turn: true,
      standing_result: standing,
      prior_result: null,
      diff: null,
      had_corrections: false,
    },
    ...overrides,
  });
}
