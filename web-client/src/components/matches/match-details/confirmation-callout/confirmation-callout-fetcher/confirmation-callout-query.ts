import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

/** The accept state behind the confirmation callout. Null from the query means
 * nothing renders.
 *
 * - `actionable`: the viewer must act on the opponent's standing proposal
 *   (negotiation states `review`/`corrected`) — surfaces the Accept CTA. Carries
 *   the standing result's id, the concurrency token `POST .../acceptance` needs.
 * - `awaiting`: the viewer's own side proposed and we're waiting on the other
 *   side to accept (negotiation state `awaiting`) — a passive notice. */
export type ConfirmationCalloutView =
  | { kind: "actionable"; resultId: string }
  | {
      kind: "awaiting";
      /** Opponent we're waiting on, for the passive label. */
      pendingSignerName: string;
    };

const selectConfirmationCallout = (
  match: MatchDetailsResult,
): ConfirmationCalloutView | null => {
  const { negotiation } = match.unmigrated;

  // The viewer must act on the opponent's standing proposal.
  if (negotiation.your_turn && negotiation.standing_result) {
    return { kind: "actionable", resultId: negotiation.standing_result.id };
  }

  // The viewer's own side proposed; surface a passive "awaiting" notice.
  if (negotiation.viewer_state === "awaiting") {
    const otherSide = match.unmigrated.sides.find(
      (s) => !s.is_current_user_side,
    );
    const pendingSignerName =
      otherSide?.players[0]?.username ?? "your opponent";
    return { kind: "awaiting", pendingSignerName };
  }

  return null;
};

export const confirmationCalloutQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectConfirmationCallout,
});
