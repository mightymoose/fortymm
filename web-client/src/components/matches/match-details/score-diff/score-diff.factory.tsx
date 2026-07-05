import type { components } from "@/api/schema";
import type { ScoreDiffProps } from "./score-diff";

type NegotiationGame = components["schemas"]["NegotiationGame"];
type NegotiationDiffEntry = components["schemas"]["NegotiationDiffEntry"];

/** One game's points in a result snapshot. */
export function buildNegotiationGame(
  overrides: Partial<NegotiationGame> = {},
): NegotiationGame {
  return {
    game_number: 1,
    side_1_points: 11,
    side_2_points: 9,
    ...overrides,
  };
}

/**
 * One diff entry. By default a *changed* game (both `old` and `new` present);
 * pass `old: null` to model a newly-added game, or `new: null` (with a
 * `game_number`) to model a removed game.
 */
export function buildNegotiationDiffEntry(
  overrides: Partial<NegotiationDiffEntry> = {},
): NegotiationDiffEntry {
  const gameNumber = overrides.new?.game_number ?? overrides.game_number ?? 1;
  return {
    game_number: gameNumber,
    old: buildNegotiationGame({ game_number: gameNumber }),
    new: buildNegotiationGame({
      game_number: gameNumber,
      side_1_points: 11,
      side_2_points: 7,
    }),
    ...overrides,
  };
}

/** Props for `ScoreDiff` — a single changed game by default. */
export function buildScoreDiffProps(
  overrides: Partial<ScoreDiffProps> = {},
): ScoreDiffProps {
  return {
    diff: [buildNegotiationDiffEntry()],
    ...overrides,
  };
}
