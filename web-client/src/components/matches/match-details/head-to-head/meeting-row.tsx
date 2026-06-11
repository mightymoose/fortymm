import { cn } from "@/lib/utils";

import { type HeadToHeadMeetingView } from "./head-to-head-query";

export interface MeetingRowProps {
  meeting: HeadToHeadMeetingView;
}

export const MeetingRow = ({ meeting }: MeetingRowProps) => (
  <div className="md-h2h__row">
    <span className="md-h2h__date">{meeting.dateLabel}</span>
    <span className="md-h2h__label">Match</span>
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
  </div>
);
