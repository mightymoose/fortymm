import type { HeadToHeadDisplayProps } from "./head-to-head-display";
import type { HeadToHeadView } from "./head-to-head-query";
import { buildHeadToHeadMeetingView } from "./meeting-row.factory";

/** A live rivalry: rita.kovac leads leo.mertens 2–1 over three meetings, with
 * the most recent (a 3–2 rita win) in the row list. */
export function buildHeadToHeadView(
  overrides: Partial<HeadToHeadView> = {},
): HeadToHeadView {
  return {
    leftLabel: "rita.kovac",
    rightLabel: "leo.mertens",
    totalMeetings: 3,
    leftWins: 2,
    rightWins: 1,
    recentMeetings: [buildHeadToHeadMeetingView()],
    ...overrides,
  };
}

/** Props for `HeadToHeadDisplay`. */
export function buildHeadToHeadDisplayProps(
  overrides: Partial<HeadToHeadDisplayProps> = {},
): HeadToHeadDisplayProps {
  return { headToHead: buildHeadToHeadView(), ...overrides };
}
