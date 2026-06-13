import type { SaveYourMatchView } from "./save-your-match-query";
import type { SaveYourMatchDisplayProps } from "./save-your-match-display";

/** The canonical nudge candidate: the viewer (initials "RK") won 3–1 over
 * leo.mertens, and the result is settled (`canConfirm: false`). */
export function buildSaveYourMatchView(
  overrides: Partial<SaveYourMatchView> = {},
): SaveYourMatchView {
  return {
    leftWon: true,
    leftInitials: "RK",
    leftGamesWon: 3,
    rightGamesWon: 1,
    rightInitials: "LM",
    rightUsername: "leo.mertens",
    createdAt: "2026-06-08T12:00:00Z",
    canConfirm: false,
    ...overrides,
  };
}

/** Props for `SaveYourMatchDisplay`. */
export function buildSaveYourMatchDisplayProps(
  overrides: Partial<SaveYourMatchDisplayProps> = {},
): SaveYourMatchDisplayProps {
  return {
    view: buildSaveYourMatchView(),
    matchId: "m-1",
    ...overrides,
  };
}
