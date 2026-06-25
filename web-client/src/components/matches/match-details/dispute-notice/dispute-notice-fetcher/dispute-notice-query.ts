import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides } from "../../ordered-sides";

/** The "your opponent disputed your result" notice shown to the submitter on a
 * disputed match. Null from the query means the notice doesn't apply — the
 * match isn't disputed, the viewer is the disputer (their acknowledgement is a
 * separate flow), or the viewer is a spectator. */
export type DisputeNoticeView = {
  /** The opponent who rejected the result, for "<name> disputed your result".
   * Falls back to "Your opponent" when the disputer can't be resolved by
   * name. */
  disputerName: string;
};

const selectDisputeNotice = (
  match: MatchDetailsResult,
): DisputeNoticeView | null => {
  const details = match.unmigrated;
  // The notice only exists on a disputed board — once the result is re-posted
  // the status leaves `disputed` and the attribution is cleared server-side.
  if (details.status !== "disputed") return null;

  const disputerId = details.disputed_by_user_id;
  if (disputerId === null) return null;

  // Only a participant sees the notice; a spectator browsing a disputed match
  // has nothing to act on.
  const [viewerSide] = orderedSides(details);
  if (!viewerSide?.is_current_user_side) return null;

  // The disputer themselves doesn't get "your result was disputed" — they did
  // the disputing (their acknowledgement is the separate #359 flow).
  const viewerUserId = viewerSide.players[0]?.user_id ?? null;
  if (viewerUserId !== null && viewerUserId === disputerId) return null;

  // Resolve the disputer's name from any side's players. Falls back to a
  // generic label if the id doesn't match a listed player (defensive).
  const disputer = details.sides
    .flatMap((side) => side.players)
    .find((player) => player.user_id === disputerId);

  return { disputerName: disputer?.username ?? "Your opponent" };
};

export const disputeNoticeQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectDisputeNotice,
});
