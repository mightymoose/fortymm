import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../match-details-query";
import type { Scoreboard } from "@/api/matches";

/** The status chip on the left of the strip; null when the match is live
 * but has no current game (nothing meaningful to announce). */
export type StatusChipView = {
  status: Scoreboard["status"];
  label: string;
} | null;

export type ScoreboardHeadingView = {
  chip: StatusChipView;
  /** e.g. "SINGLES · BO5" */
  formatLabel: string;
  /** e.g. "First to 3"; null for an upcoming match, where the race to a
   * games target hasn't started. */
  raceLabel: string | null;
};

export type ScoreboardView = {
  status: Scoreboard["status"];
  outcome: string | null;
  heading: ScoreboardHeadingView;
};

const games = (n: number) => `${n} ${n === 1 ? "game" : "games"}`;

const selectOutcome = (match: MatchDetailsResult): string | null => {
  const sides = match.unmigrated.sides;

  // Decided match: one side won, the other lost.
  const winner = sides.find((s) => s.won === true);
  const loser = sides.find((s) => s.won === false);
  if (winner?.players[0] && loser?.players[0]) {
    return `${winner.players[0].username} defeated ${loser.players[0].username}, ${games(winner.games_won)} to ${loser.games_won}`;
  }

  // Still in progress: describe the current state from games won. Needs both
  // sides' lead player to name them.
  const [side1, side2] = sides;
  if (!side1?.players[0] || !side2?.players[0]) {
    return null;
  }

  if (side1.games_won === 0 && side2.games_won === 0) {
    return `${side1.players[0].username} and ${side2.players[0].username} have not started yet`;
  }

  if (side1.games_won === side2.games_won) {
    return `${side1.players[0].username} and ${side2.players[0].username} are tied, ${games(side1.games_won)} all`;
  }

  const [leader, trailer] =
    side1.games_won > side2.games_won ? [side1, side2] : [side2, side1];
  return `${leader.players[0].username} leading, ${games(leader.games_won)} to ${trailer.games_won}`;
};

const selectChip = (
  status: Scoreboard["status"],
  details: MatchDetailsResult["unmigrated"],
): StatusChipView => {
  if (status === "live") {
    return details.current_game
      ? { status, label: `Live · Game ${details.current_game.game_number}` }
      : null;
  }
  if (status === "final") {
    return { status, label: "Final" };
  }
  return { status, label: details.status_label };
};

const selectHeading = (match: MatchDetailsResult): ScoreboardHeadingView => {
  const status = match.data.scoreboard.status;
  const details = match.unmigrated;

  return {
    chip: selectChip(status, details),
    formatLabel: `${details.team_size === 1 ? "SINGLES" : "DOUBLES"} · BO${details.best_of}`,
    raceLabel:
      status === "scheduled" ? null : `First to ${details.games_to_win}`,
  };
};

const selectScoreboard = (match: MatchDetailsResult): ScoreboardView => ({
  status: match.data.scoreboard.status,
  outcome: selectOutcome(match),
  heading: selectHeading(match),
});

export const scoreboardQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectScoreboard,
});
