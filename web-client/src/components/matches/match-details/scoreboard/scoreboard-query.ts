import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../match-details-query";
import type { Scoreboard } from "@/api/matches";

export type ScoreboardView = {
  status: Scoreboard["status"];
  outcome: string | null;
};

const games = (n: number) => `${n} ${n === 1 ? "game" : "games"}`;

const selectScoreboard = (match: MatchDetailsResult) => {
  const status = match.data.scoreboard.status;
  const sides = match.unmigrated.sides;

  // Decided match: one side won, the other lost.
  const winner = sides.find((s) => s.won === true);
  const loser = sides.find((s) => s.won === false);
  if (winner?.players[0] && loser?.players[0]) {
    const outcome = `${winner.players[0].username} defeated ${loser.players[0].username}, ${games(winner.games_won)} to ${loser.games_won}`;
    return { status, outcome };
  }

  // Still in progress: describe the current state from games won. Needs both
  // sides' lead player to name them.
  const [side1, side2] = sides;
  if (!side1?.players[0] || !side2?.players[0]) {
    return { status, outcome: null };
  }

  if (side1.games_won === 0 && side2.games_won === 0) {
    const outcome = `${side1.players[0].username} and ${side2.players[0].username} have not started yet`;
    return { status, outcome };
  }

  if (side1.games_won === side2.games_won) {
    const outcome = `${side1.players[0].username} and ${side2.players[0].username} are tied, ${games(side1.games_won)} all`;
    return { status, outcome };
  }

  const [leader, trailer] =
    side1.games_won > side2.games_won ? [side1, side2] : [side2, side1];
  const outcome = `${leader.players[0].username} leading, ${games(leader.games_won)} to ${trailer.games_won}`;
  return { status, outcome };
};

export const scoreboardQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectScoreboard,
});
