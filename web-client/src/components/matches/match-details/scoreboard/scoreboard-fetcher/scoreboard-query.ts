import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides } from "../../ordered-sides";
import type { Scoreboard } from "@/api/matches";
import { initialsOf } from "@/lib/utils";

/** The status chip on the left of the strip. Its label comes from the
 * server's lifecycle `status_label` (Live / Awaiting confirmation / Final /
 * Disputed / Voided / Scheduled), so it never contradicts the Match-info
 * Status field — the one exception being a live match with a game in progress,
 * which reads "Live · Game N". Always present. */
export type StatusChipView = {
  status: Scoreboard["status"];
  label: string;
};

export type ScoreboardHeadingView = {
  chip: StatusChipView;
  /** e.g. "SINGLES · BO5" */
  formatLabel: string;
  /** e.g. "First to 3"; null for an upcoming match, where the race to a
   * games target hasn't started. */
  raceLabel: string | null;
};

/** One slot in a game-grid row. Every row is padded to `bestOf` cells, so a
 * slot may be a scored game, an unscored (possibly live) game, or a game that
 * doesn't exist yet — the latter two render identically except for the live
 * highlight. */
export type GameGridCellView =
  | { kind: "unplayed"; isLive: boolean }
  | {
      kind: "scored";
      points: number;
      won: boolean;
      /** Game number to link the cell to its scores/edit route; null when the
       * viewer can't edit this cell (spectator, or the opponent's row). */
      editGameNumber: number | null;
    };

export type GameGridRowView = {
  /** Lead player's username, or "No opponent" for a playerless ghost side. */
  name: string;
  initials: string;
  isGhost: boolean;
  won: boolean;
  gamesWon: number;
  cells: GameGridCellView[];
};

/** The per-game score grid at the bottom of the scoreboard. Rows are
 * perspective-ordered: the viewer's side first when they're a participant,
 * otherwise side 1 first. */
export type GameGridView = {
  matchId: string;
  bestOf: number;
  rows: [GameGridRowView, GameGridRowView];
};

/** One competitor in the hero row. A ghost side stands in for a missing
 * opponent — a playerless side row, or no second side at all — and renders
 * as the dashed "No opponent" placeholder instead of an avatar. */
export type HeroSideView = {
  /** Lead player's username, or "No opponent" for a ghost side. */
  name: string;
  initials: string;
  isGhost: boolean;
  won: boolean;
};

/** One side's half of the hero scoreline; `won` drives the win highlight. */
export type HeroScorelineSideView = {
  gamesWon: number;
  won: boolean;
};

/** The center block between the two hero players: a "VS · <status>"
 * placeholder until the match starts, then the games-won scoreline. */
export type HeroScoreView =
  | { kind: "upcoming"; statusLabel: string }
  | {
      kind: "scoreline";
      left: HeroScorelineSideView;
      right: HeroScorelineSideView;
    };

/** The hero row across the middle of the scoreboard: left player, center
 * score block, right player. Sides are perspective-ordered like the game
 * grid — the viewer's side reads left when they're a participant, otherwise
 * side 1 is left. */
export type HeroRowView = {
  left: HeroSideView;
  score: HeroScoreView;
  right: HeroSideView;
};

export type ScoreboardView = {
  status: Scoreboard["status"];
  outcome: string | null;
  heading: ScoreboardHeadingView;
  heroRow: HeroRowView;
  /** Null when there's nothing to tabulate: an upcoming match, or a match
   * without two sides. */
  gameGrid: GameGridView | null;
};

const games = (n: number) => `${n} ${n === 1 ? "game" : "games"}`;

/** Mirrors the server's `_status_label` for the posted-but-unconfirmed state
 * (api/app/matches.py). The BFF owns lifecycle labels, so we key off the
 * string rather than re-deriving the state from `signatures` on the client. */
const AWAITING_CONFIRMATION = "Awaiting confirmation";

const selectOutcome = (match: MatchDetailsResult): string | null => {
  const details = match.unmigrated;
  const sides = details.sides;

  // Decided & confirmed: one side won, the other lost.
  const winner = sides.find((s) => s.won === true);
  const loser = sides.find((s) => s.won === false);
  if (winner?.players[0] && loser?.players[0]) {
    return `${winner.players[0].username} defeated ${loser.players[0].username} by ${games(winner.games_won)} to ${loser.games_won}`;
  }

  // Still in progress (or posted, awaiting confirmation): describe the current
  // state from games won. Needs both sides' lead player to name them.
  const [side1, side2] = sides;
  if (!side1?.players[0] || !side2?.players[0]) {
    return null;
  }

  // Result posted, waiting on the other side to confirm: the board is
  // mathematically decided, so call it "won" — not "leading", which implies
  // play continues — and flag the pending sign-off (#491). The prospective
  // winner is whichever side reached the games target.
  if (details.status_label === AWAITING_CONFIRMATION) {
    const [winner, loser] =
      side1.games_won >= side2.games_won ? [side1, side2] : [side2, side1];
    return `${winner.players[0].username} won ${games(winner.games_won)} to ${loser.games_won} — awaiting confirmation`;
  }

  if (side1.games_won === 0 && side2.games_won === 0) {
    return `${side1.players[0].username} and ${side2.players[0].username} have not started yet`;
  }

  if (side1.games_won === side2.games_won) {
    return `${side1.players[0].username} and ${side2.players[0].username} are tied at ${games(side1.games_won)} apiece`;
  }

  const [leader, trailer] =
    side1.games_won > side2.games_won ? [side1, side2] : [side2, side1];
  return `${leader.players[0].username} leads by ${games(leader.games_won)} to ${trailer.games_won}`;
};

const selectChip = (
  status: Scoreboard["status"],
  details: MatchDetailsResult["unmigrated"],
): StatusChipView => {
  // A game is actively being played — name it. Otherwise defer to the server's
  // lifecycle label, which already distinguishes the states the coarse
  // scoreboard status flattens: "Awaiting confirmation" and "Live" both map to
  // `live` (so a posted-but-unconfirmed or between-games board still gets a
  // chip, #491/#492), and "Disputed"/"Voided"/"Final" all map to `final` (so a
  // disputed board's chip reads "Disputed", not "Final", #561).
  if (status === "live" && details.current_game) {
    return { status, label: `Live · Game ${details.current_game.game_number}` };
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

type MatchDetailsSide = MatchDetailsResult["unmigrated"]["sides"][number];
type MatchDetailsGame = MatchDetailsResult["unmigrated"]["games"][number];

const NO_OPPONENT_LABEL = "No opponent";

const selectHeroSide = (side: MatchDetailsSide | null): HeroSideView => {
  const player = side?.players[0] ?? null;
  const name = player?.username ?? NO_OPPONENT_LABEL;
  return {
    name,
    initials: initialsOf(name),
    isGhost: player === null,
    won: side?.won === true,
  };
};

const selectHeroRow = (match: MatchDetailsResult): HeroRowView => {
  const details = match.unmigrated;
  const [first, second] = orderedSides(details);
  const score: HeroScoreView =
    match.data.scoreboard.status === "scheduled"
      ? { kind: "upcoming", statusLabel: details.status_label }
      : {
          kind: "scoreline",
          left: { gamesWon: first?.games_won ?? 0, won: first?.won === true },
          right: {
            gamesWon: second?.games_won ?? 0,
            won: second?.won === true,
          },
        };
  return { left: selectHeroSide(first), score, right: selectHeroSide(second) };
};

const selectGameGridRow = (
  side: MatchDetailsSide,
  slots: Array<MatchDetailsGame | null>,
  details: MatchDetailsResult["unmigrated"],
  editable: boolean,
): GameGridRowView => {
  const name = side.players[0]?.username ?? NO_OPPONENT_LABEL;
  return {
    name,
    initials: initialsOf(name),
    isGhost: side.players.length === 0,
    won: side.won === true,
    gamesWon: side.games_won,
    cells: slots.map((game): GameGridCellView => {
      if (!game?.score) {
        return {
          kind: "unplayed",
          isLive:
            game !== null &&
            details.current_game?.game_number === game.game_number,
        };
      }
      return {
        kind: "scored",
        points:
          side.side_number === 1
            ? game.score.side_1_points
            : game.score.side_2_points,
        won: game.score.winner_side_number === side.side_number,
        editGameNumber:
          editable && game.score.id ? game.game_number : null,
      };
    }),
  };
};

const selectGameGrid = (match: MatchDetailsResult): GameGridView | null => {
  // An upcoming match has no games to tabulate — the hero shows "VS" instead.
  if (match.data.scoreboard.status === "scheduled") return null;

  const details = match.unmigrated;
  const [first, second] = orderedSides(details);
  if (!first || !second) return null;

  // Pad to best_of so the grid always renders the same number of cells.
  const gamesByNumber = new Map(details.games.map((g) => [g.game_number, g]));
  const slots: Array<MatchDetailsGame | null> = [];
  for (let n = 1; n <= details.best_of; n += 1) {
    slots.push(gamesByNumber.get(n) ?? null);
  }

  // Per-cell edit links are gated on participation — spectators can't write
  // scores — and only the viewer's own row carries them, so the user doesn't
  // see two stacked links over the same game.
  const canEdit = first.is_current_user_side;
  return {
    matchId: details.id,
    bestOf: details.best_of,
    rows: [
      selectGameGridRow(first, slots, details, canEdit),
      selectGameGridRow(second, slots, details, false),
    ],
  };
};

const selectScoreboard = (match: MatchDetailsResult): ScoreboardView => ({
  status: match.data.scoreboard.status,
  outcome: selectOutcome(match),
  heading: selectHeading(match),
  heroRow: selectHeroRow(match),
  gameGrid: selectGameGrid(match),
});

export const scoreboardQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectScoreboard,
});
