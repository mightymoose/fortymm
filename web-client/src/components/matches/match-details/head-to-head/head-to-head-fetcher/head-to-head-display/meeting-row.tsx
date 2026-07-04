import { Link } from "@tanstack/react-router";

import { matchDetailRoute } from "@/api/matches";
import { cn } from "@/lib/utils";

import { type HeadToHeadMeetingView } from "../head-to-head-query";

export interface MeetingRowProps {
  meeting: HeadToHeadMeetingView;
}

/** A bare "W"/"L" reads as a personal result ("you won"), which has no
 * referent for a spectator watching two other players' history (#499) — so
 * the outcome is conveyed by tinting whichever side's game count actually
 * won, the same way the scoreboard's hero row and game grid do. */
export const MeetingRow = ({ meeting }: MeetingRowProps) => (
  <Link
    {...matchDetailRoute(meeting.matchId)}
    className="md-h2h__row"
    aria-label={`Open match from ${meeting.dateLabel}`}
  >
    <span className="md-h2h__date">{meeting.dateLabel}</span>
    <span className="md-h2h__meta">
      <span className="md-h2h__label">Match</span>
      {meeting.rated && <span className="md-h2h__tag">Rated</span>}
      {meeting.leftWon === null && (
        <span className="md-h2h__tag md-h2h__tag--neutral">No result</span>
      )}
    </span>
    <span className="md-h2h__score">
      <span
        className={cn(
          "md-h2h__score-side",
          meeting.leftWon === true && "md-h2h__score-side--win",
        )}
      >
        {meeting.leftGamesWon}
      </span>
      <span className="md-h2h__score-sep">–</span>
      <span
        className={cn(
          "md-h2h__score-side",
          meeting.leftWon === false && "md-h2h__score-side--win",
        )}
      >
        {meeting.rightGamesWon}
      </span>
    </span>
  </Link>
);
