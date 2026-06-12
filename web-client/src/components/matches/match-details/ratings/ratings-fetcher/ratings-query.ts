import { formatRatingDelta } from "@/lib/rating";
import { initialsOf } from "@/lib/utils";

import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides, type MatchDetailsSide } from "../../ordered-sides";

/** The numbers half of a rated row — all values pre-formatted. */
export type RatingRowChangeView = {
  /** Rounded pre-match rating; null when the player entered unrated (the
   * numbers line then leads straight with the arrow into `to`). */
  from: number | null;
  /** Rounded post-match rating. */
  to: number;
  /** Signed, rounded delta, e.g. "+12" / "-8". */
  deltaLabel: string;
  /** True for a non-negative delta — picks the delta figure's up/down tone. */
  deltaUp: boolean;
  /** Series for the trend sparkline: the pre-match rating history with the
   * post-match value appended (anchored at `from` when there's no history).
   * Null when that leaves fewer than two points to draw a line through. */
  sparkline: number[] | null;
};

/** One side's row in the rating-change card. */
export type RatingRowView = {
  /** The side's player name, or a "You"/"Opponent"/"Side N" stand-in for a
   * playerless side. */
  username: string;
  initials: string;
  /** True only when this side won the match — picks the avatar tone. */
  won: boolean;
  /** The rating movement; null when this side's rating didn't move
   * (renders as "Unrated player" with no delta block). */
  change: RatingRowChangeView | null;
};

/** The "Result · rating change" sidebar card. Rows are perspective-ordered
 * like the scoreboard: the viewer's side first when they're a participant,
 * otherwise side 1 then side 2. */
export type RatingsView = {
  rows: RatingRowView[];
};

const selectChange = (
  side: MatchDetailsSide,
  history: number[],
): RatingRowChangeView | null => {
  const change = side.rating_change;
  if (!change) return null;
  // history is anchored "before this match"; append the post-match value so
  // the line lands on the new rating.
  const series = [...history];
  if (series.length === 0 && change.before !== null) {
    series.push(change.before);
  }
  series.push(change.after);
  return {
    from: change.before === null ? null : Math.round(change.before),
    to: Math.round(change.after),
    deltaLabel: formatRatingDelta(change.delta),
    deltaUp: change.delta >= 0,
    sparkline: series.length >= 2 ? series : null,
  };
};

const selectRow = (
  side: MatchDetailsSide,
  fallbackLabel: string,
  details: MatchDetailsResult["unmigrated"],
): RatingRowView => {
  const player = side.players[0];
  const username = player?.username ?? fallbackLabel;
  const history =
    details.recent_form?.find((f) => f.user_id === player?.user_id)
      ?.rating_history ?? [];
  return {
    username,
    initials: initialsOf(username),
    won: side.won === true,
    change: selectChange(side, history),
  };
};

const selectRatings = (match: MatchDetailsResult): RatingsView | null => {
  // Only an over-and-done match has a real rating change to show. A live match
  // may carry seeded/projected ratings that look like a finished result — the
  // snapshot panel already states the pre-match numbers, so a "result" card
  // mid-match reads as a contradiction. (Flagged for design: a live
  // "PROJECTED · IF … WINS" card could replace this later.)
  if (match.data.scoreboard.status !== "final") return null;
  const details = match.unmigrated;
  const [first, second] = orderedSides(details);
  const sides = [first, second].filter((s): s is MatchDetailsSide => s !== null);
  if (!sides.some((s) => s.rating_change != null)) return null;
  const viewerIsParticipant = first?.is_current_user_side === true;
  const fallbackLabels = viewerIsParticipant
    ? ["You", "Opponent"]
    : ["Side 1", "Side 2"];
  return {
    rows: sides.map((side, i) => selectRow(side, fallbackLabels[i], details)),
  };
};

export const ratingsQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectRatings,
});
