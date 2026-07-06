import { initialsOf } from "@/lib/utils";

import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides } from "../../ordered-sides";

/** The match anchor + body copy for the guest "save this match" nudge, shaped
 * for the viewer's perspective (left side = the viewer). Null from the query
 * means the prompt doesn't apply and nothing renders. */
export type SaveYourMatchView = {
  /** True only when the viewer's side won — picks the win/loss avatar tone.
   * Null mid-match, before a result is decided. */
  leftWon: boolean | null;
  leftInitials: string;
  leftGamesWon: number;
  rightGamesWon: number;
  rightInitials: string;
  /** The opponent's name, used in the "your rivalry with X" body copy. */
  rightUsername: string;
  /** When the match was created — stamped onto the anchor. */
  createdAt: string;
  /** When the viewer still has a result to accept, soften the card so it
   * doesn't compete with the confirmation callout above it. */
  canConfirm: boolean;
};

const selectSaveYourMatch = (
  match: MatchDetailsResult,
): SaveYourMatchView | null => {
  // Show as soon as the match is being played — we don't wait for the
  // opponent's acceptance. The "save it before cookies clear" risk applies the
  // moment the guest has invested real time, not just at the rated-finalized
  // boundary (which can be hours later, after the guest has closed the tab).
  if (match.data.scoreboard.status === "scheduled") return null;

  const details = match.unmigrated;
  const [left, right] = orderedSides(details);

  // The viewer must be the participant on the left side, facing a real
  // (non-ghost) opponent — the prompt is "save *your* rivalry with X".
  if (!left?.is_current_user_side) return null;
  if (!right || right.players.length === 0) return null;

  const leftName = left.players[0]?.username ?? "You";
  const rightName = right.players[0]?.username ?? "Opponent";
  return {
    leftWon: left.won,
    leftInitials: initialsOf(leftName),
    leftGamesWon: left.games_won,
    rightGamesWon: right.games_won,
    rightInitials: initialsOf(rightName),
    rightUsername: rightName,
    createdAt: details.created_at,
    canConfirm: details.negotiation.your_turn,
  };
};

export const saveYourMatchQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectSaveYourMatch,
});
