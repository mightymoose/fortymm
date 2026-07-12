import { formatRatingDelta, formatRatingDeltaAria } from "@/lib/rating";
import { initialsOf } from "@/lib/utils";

import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides, type MatchDetailsSide } from "../../ordered-sides";

/** A player who was **already rated** and whose rating this match MOVED:
 * `1612 → 1624`, `+12`. All values pre-formatted. */
export type RatingRowMovedView = {
  kind: "moved";
  /** Rounded pre-match rating. */
  from: number;
  /** Rounded post-match rating. */
  to: number;
  /** Signed, rounded delta, e.g. "+12" / "-8". */
  deltaLabel: string;
  /** Spoken form of `deltaLabel` for the delta chip's `aria-label`, e.g.
   * "Gained 12 rating" — so a reader doesn't voice the "+" as punctuation. */
  deltaAriaLabel: string;
  /** True for a non-negative delta — picks the delta figure's up/down tone. */
  deltaUp: boolean;
  /** Series for the trend sparkline: the pre-match rating history with the
   * post-match value appended (anchored at `from` when there's no history).
   * Null when that leaves fewer than two points to draw a line through. */
  sparkline: number[] | null;
};

/** A player whose **first rated match** this was: they went in Unrated and came
 * out at `to`. The row reads `Unrated → 1268`.
 *
 * There is deliberately **no delta and no sparkline** on this variant — not a
 * "+0", not a fall from the 1500 their league-join seeded. Nothing moved: a
 * rating came into existence (#952). A trend line would have to start at a point
 * the player never held, so there is none to draw.
 */
export type RatingRowEstablishedView = {
  kind: "established";
  /** Rounded post-match rating — the rating this match *gave* them. */
  to: number;
  /** Accessible name for the numbers line, since the chevron is decorative and
   * "Unrated 1268" is not a sentence. */
  ariaLabel: string;
};

/**
 * The numbers half of a rated row. **Two kinds, and the difference is the whole
 * point**: a rating can be *moved* or it can be *established*, and only the
 * first of those has a delta. Collapsing them back into one nullable shape is
 * how a first-rated player came to be told they lost 232 points of a rating they
 * never had (#952) — the union is here to make that unwritable.
 */
export type RatingRowChangeView = RatingRowMovedView | RatingRowEstablishedView;

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
  // Null #1: the match moved no rating at all (unrated match, undecided,
  // voided). The row reads "Unrated player" — no numbers line, no chip.
  if (!change) return null;
  // Null #2, and it means something else entirely: the change is PRESENT but
  // has no delta, because there was no prior rating to measure from. This match
  // *established* the player. `before` is null for the same reason, and testing
  // both is not belt-and-braces — it is what narrows `before` to a number below,
  // where `formatRatingDelta` would otherwise have been handed a `null` and
  // `null >= 0` would have painted a bogus "up" chip (#952).
  if (change.delta === null || change.before === null) {
    const to = Math.round(change.after);
    return {
      kind: "established",
      to,
      ariaLabel: `Unrated before this match, now rated ${to}`,
    };
  }
  // history is anchored "before this match"; append the post-match value so
  // the line lands on the new rating.
  const series = history.length === 0 ? [change.before] : [...history];
  series.push(change.after);
  return {
    kind: "moved",
    from: Math.round(change.before),
    to: Math.round(change.after),
    deltaLabel: formatRatingDelta(change.delta),
    deltaAriaLabel: formatRatingDeltaAria(change.delta),
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
