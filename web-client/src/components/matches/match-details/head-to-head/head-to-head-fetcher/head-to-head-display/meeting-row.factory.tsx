import type { HeadToHeadMeetingView } from "../head-to-head-query";
import type { MeetingRowProps } from "./meeting-row";

/** A 3–2 win for the left (perspective-first) side on May 8. */
export function buildHeadToHeadMeetingView(
  overrides: Partial<HeadToHeadMeetingView> = {},
): HeadToHeadMeetingView {
  return {
    matchId: "m-h2h-1",
    dateLabel: "May 8",
    rated: true,
    leftGamesWon: 3,
    rightGamesWon: 2,
    leftWon: true,
    ...overrides,
  };
}

/** Props for `MeetingRow`. */
export function buildMeetingRowProps(
  overrides: Partial<MeetingRowProps> = {},
): MeetingRowProps {
  return { meeting: buildHeadToHeadMeetingView(), ...overrides };
}
