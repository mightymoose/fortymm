import { fmtDateShort } from "@/lib/dates";

import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";
import { orderedSides, type MatchDetailsSide } from "../../ordered-sides";

/** One prior meeting between the two sides, rendered as a row in the card.
 * Game counts and the win flag are aligned to the card's left/right anchor so
 * the component does no per-row re-mapping. */
export type HeadToHeadMeetingView = {
  /** The past match's id — a stable React key; not currently linked. */
  matchId: string;
  /** Pre-formatted meeting date, e.g. "May 8". */
  dateLabel: string;
  /** Games won by the left (perspective-first) side in that meeting. */
  leftGamesWon: number;
  /** Games won by the right side in that meeting. */
  rightGamesWon: number;
  /** True when the left side won, false when the right side won, null when no
   * winner was recorded (e.g. a voided match where `won` was never set). */
  leftWon: boolean | null;
};

/** The "Head to head" sidebar card. Counts and meetings are perspective-ordered
 * like the scoreboard: the viewer's side reads left when they're a participant,
 * otherwise side 1 is left and side 2 is right. */
export type HeadToHeadView = {
  /** Left side's player name, or a "You"/"Side 1" stand-in for a playerless
   * side. */
  leftLabel: string;
  /** Right side's player name, or an "Opponent"/"Side 2" stand-in. */
  rightLabel: string;
  /** Total prior meetings the record covers; 0 reads as a fresh rivalry. */
  totalMeetings: number;
  /** Decided meetings won by the left side. */
  leftWins: number;
  /** Decided meetings won by the right side. */
  rightWins: number;
  /** The most recent meetings, newest first. Empty when `totalMeetings` is 0. */
  recentMeetings: HeadToHeadMeetingView[];
};

const sideLabel = (
  side: MatchDetailsSide | null,
  playerFallback: string,
): string => side?.players[0]?.username ?? playerFallback;

const selectHeadToHead = (match: MatchDetailsResult): HeadToHeadView | null => {
  const details = match.unmigrated;
  const raw = details.head_to_head;
  // The card mounts unconditionally; the gate "is there any record to show"
  // lives here. A null `head_to_head` (no shared history endpoint payload)
  // hides the card; a record with zero meetings still shows the empty-rivalry
  // state.
  if (!raw) return null;

  const [first, second] = orderedSides(details);
  const viewerIsParticipant = first?.is_current_user_side === true;
  const leftLabel = sideLabel(first, viewerIsParticipant ? "You" : "Side 1");
  const rightLabel = second
    ? sideLabel(second, viewerIsParticipant ? "Opponent" : "Side 2")
    : viewerIsParticipant
      ? "Opponent"
      : "Side 2";

  // The API frames game counts and `winner_side_number` against this match's
  // side numbers. When the left anchor is side 2 (viewer is side 2), swap so
  // left/right read from the viewer's perspective.
  const leftSideNumber = first?.side_number ?? 1;
  const swap = leftSideNumber !== 1;

  return {
    leftLabel,
    rightLabel,
    totalMeetings: raw.total_meetings,
    leftWins: swap ? raw.side_2_wins : raw.side_1_wins,
    rightWins: swap ? raw.side_1_wins : raw.side_2_wins,
    recentMeetings: raw.recent_meetings.map((m) => ({
      matchId: m.match_id,
      dateLabel: fmtDateShort(m.completed_at),
      leftGamesWon: swap ? m.side_2_games_won : m.side_1_games_won,
      rightGamesWon: swap ? m.side_1_games_won : m.side_2_games_won,
      leftWon:
        m.winner_side_number === null
          ? null
          : m.winner_side_number === leftSideNumber,
    })),
  };
};

export const headToHeadQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectHeadToHead,
});
