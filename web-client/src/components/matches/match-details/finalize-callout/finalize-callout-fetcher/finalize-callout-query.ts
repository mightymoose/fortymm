import type { components } from "@/api/schema";

import { compactGames } from "@/lib/scoring";
import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

type MatchResultsGameWrite = components["schemas"]["MatchResultsGameWrite"];

/** The decided-but-unposted board behind the "Post result" callout. Null from
 * the query means there's nothing postable and the callout doesn't render. */
export type FinalizeCalloutView = {
  /** The canonical games to post, built from the saved (perspective-agnostic)
   * side-1/side-2 scores so a one-click "Post result" sends exactly what's on
   * the board — scored games only, in game order. */
  games: MatchResultsGameWrite[];
};

const selectFinalizeCallout = (
  match: MatchDetailsResult,
): FinalizeCalloutView | null => {
  const details = match.unmigrated;
  // Only a participant on a decided-but-unsigned board gets a view (the
  // backend gates `can_finalize` on participation + validity + no signature).
  // This is the recovery path for scores entered then left unposted, and the
  // one-click resubmit after a mistaken dispute — the scratchpad scores
  // survive a dispute, so re-posting them unchanged drops back into the
  // sign-off flow.
  if (!details.can_finalize) return null;
  return {
    // The recovery surface for an already-stuck gappy-decided match: the
    // server's `_can_finalize` now compacts, so `can_finalize` is true here;
    // post the compacted board to match what the server mints (see
    // `compactGames`). #742
    games: compactGames(
      details.games
        .filter((g) => g.score)
        .map((g) => ({
          game_number: g.game_number,
          side_1_points: g.score!.side_1_points,
          side_2_points: g.score!.side_2_points,
        })),
    ),
  };
};

export const finalizeCalloutQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectFinalizeCallout,
});
