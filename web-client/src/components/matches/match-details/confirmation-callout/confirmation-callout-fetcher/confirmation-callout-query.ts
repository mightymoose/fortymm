import type { components } from "@/api/schema";

import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

type NegotiationDiffEntry = components["schemas"]["NegotiationDiffEntry"];

/** The result-negotiation state behind the match-detail callout, keyed off
 * `negotiation.viewer_state`. Null from the query means there's nothing to show
 * for this viewer — a live match with no proposal in play, or a settled match
 * (see the note below the per-state list).
 *
 * - `review`: the opponent posted the first result; the viewer must Accept or
 *   open the correction route ("Suggest correction"). Carries the standing
 *   result id (the acceptance token) and the rated stakes.
 * - `corrected`: the opponent countered the viewer's own prior proposal; the
 *   viewer must Accept the correction or counter back. Adds the server-computed
 *   `diff` so the callout can highlight what changed.
 * - `awaiting`: the viewer's own side proposed; we wait on the opponent. A
 *   passive notice plus an "Edit result" action (a self-edit that supersedes
 *   the viewer's standing proposal).
 *
 * A settled match (`final`) projects to null — once the negotiation is over the
 * callout has nothing left to say, so it doesn't render. */
export type ConfirmationCalloutView =
  | { kind: "review"; resultId: string; rated: boolean }
  | {
      kind: "corrected";
      resultId: string;
      rated: boolean;
      diff: NegotiationDiffEntry[];
    }
  | {
      kind: "awaiting";
      /** Opponent we're waiting on, for the passive label. */
      pendingSignerName: string;
    };

const selectConfirmationCallout = (
  match: MatchDetailsResult,
): ConfirmationCalloutView | null => {
  const { negotiation } = match.unmigrated;
  const rated = match.unmigrated.affects_rating;

  switch (negotiation.viewer_state) {
    case "review": {
      // The opponent posted the first result; the viewer must act.
      if (!negotiation.standing_result) return null;
      return { kind: "review", resultId: negotiation.standing_result.id, rated };
    }

    case "corrected": {
      // The opponent countered the viewer's own prior proposal; show the diff.
      if (!negotiation.standing_result) return null;
      return {
        kind: "corrected",
        resultId: negotiation.standing_result.id,
        rated,
        diff: negotiation.diff ?? [],
      };
    }

    case "awaiting": {
      // The viewer's own side proposed; surface a passive "awaiting" notice.
      const otherSide = match.unmigrated.sides.find(
        (s) => !s.is_current_user_side,
      );
      const pendingSignerName =
        otherSide?.players[0]?.username ?? "your opponent";
      return { kind: "awaiting", pendingSignerName };
    }

    default:
      // `live` (no proposal in play) or `final` (the match is settled) — there's
      // no sign-off to surface, so nothing renders.
      return null;
  }
};

export const confirmationCalloutQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectConfirmationCallout,
});
