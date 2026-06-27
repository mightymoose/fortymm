import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides } from "../../ordered-sides";

/** The sign-off state behind the confirmation callout. Null from the query
 * means neither state applies and nothing renders.
 *
 * - `actionable`: the viewer can hit ``POST /confirmation`` or
 *   ``POST /dispute`` — surfaces the featured Confirm / Dispute CTAs.
 * - `awaiting`: the viewer has already signed and we're waiting on the other
 *   side — surfaces the passive "Awaiting <opponent>" notice. */
export type ConfirmationCalloutView =
  | { kind: "actionable" }
  | {
      kind: "awaiting";
      /** The user whose signature we're waiting on, for the passive label —
       * "your opponent" when the unsigned player can't be resolved by name. */
      pendingSignerName: string;
      /** True when the viewer posted this pending result and may retract it —
       * drives the "Withdraw result" CTA on the passive notice (the submitter's
       * escape hatch; they can't confirm/dispute their own result). */
      canWithdraw: boolean;
    };

const selectConfirmationCallout = (
  match: MatchDetailsResult,
): ConfirmationCalloutView | null => {
  const details = match.unmigrated;
  // `can_confirm` is the backend's word that the viewer is a participant
  // facing a posted result they haven't signed — it wins over the passive
  // state (you can't be awaiting someone else while it's your turn).
  if (details.can_confirm) return { kind: "actionable" };

  // The passive notice is gated on the live (``in_progress``) state: a posted
  // result keeps the match in_progress until the other side signs, at which
  // point /confirmation flips it to ``completed``. Once finalized (or
  // disputed/voided) the signatures still exist, so without this status check
  // the notice would linger above a Final match — even across a reload. See
  // #358.
  if (match.data.scoreboard.status !== "live") return null;

  // The viewer must be a signed participant with at least one signature on
  // record; spectators and anonymous viewers never see this state.
  const [viewerSide, otherSide] = orderedSides(details);
  if (!viewerSide?.is_current_user_side || !otherSide) return null;
  const signers = new Set(details.signatures.map((sig) => sig.user_id));
  const viewerUserId = viewerSide.players[0]?.user_id ?? null;
  if (
    details.signatures.length === 0 ||
    viewerUserId === null ||
    !signers.has(viewerUserId)
  ) {
    return null;
  }

  // Find the participant who's missing from the signature set. With "at
  // least one player per side" semantics, this picks the first un-signed
  // player on the other side. Falls back to "your opponent" if we can't
  // resolve a name.
  const missing = otherSide.players.find((p) => !signers.has(p.user_id));
  return {
    kind: "awaiting",
    pendingSignerName: missing?.username ?? "your opponent",
    canWithdraw: details.can_withdraw,
  };
};

export const confirmationCalloutQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectConfirmationCallout,
});
