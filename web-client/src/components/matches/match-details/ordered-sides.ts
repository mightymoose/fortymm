import type { MatchDetailsResult } from "./match-details-query";

export type MatchDetailsSide =
  MatchDetailsResult["unmigrated"]["sides"][number];

/**
 * Perspective ordering shared by the scoreboard (hero row, game grid) and the
 * players panel: the viewer's side reads first when they're a participant,
 * otherwise side 1 / side 2.
 */
export const orderedSides = (
  details: MatchDetailsResult["unmigrated"],
): [MatchDetailsSide | null, MatchDetailsSide | null] => {
  const bySideNumber = [...details.sides].sort(
    (a, b) => a.side_number - b.side_number,
  );
  const mine = bySideNumber.find((s) => s.is_current_user_side);
  const first = mine ?? bySideNumber[0] ?? null;
  const second = bySideNumber.find((s) => s !== first) ?? null;
  return [first, second];
};
