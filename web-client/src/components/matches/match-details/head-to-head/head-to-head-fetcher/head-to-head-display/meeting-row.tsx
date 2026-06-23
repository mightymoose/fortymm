import { Link } from "@tanstack/react-router";

import { matchDetailRoute } from "@/api/matches";
import { cn } from "@/lib/utils";

import { type HeadToHeadMeetingView } from "../head-to-head-query";

export interface MeetingRowProps {
  meeting: HeadToHeadMeetingView;
}

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
    </span>
    <span
      className={cn("md-h2h__score", meeting.leftWon === true && "md-h2h__score--win")}
    >
      {meeting.leftGamesWon}–{meeting.rightGamesWon}
    </span>
    <span
      className={cn(
        "md-h2h__result",
        meeting.leftWon === true && "md-h2h__result--w",
        meeting.leftWon === false && "md-h2h__result--l",
      )}
    >
      {meeting.leftWon === true ? "W" : meeting.leftWon === false ? "L" : "–"}
    </span>
  </Link>
);
