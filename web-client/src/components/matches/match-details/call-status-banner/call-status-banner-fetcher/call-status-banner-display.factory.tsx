import type { CallStatusBannerDisplayProps } from "./call-status-banner-display";
import type { CallStatusView } from "./call-status-banner-query";

/** A live tournament fixture waiting to be called, viewed by its owner —
 * the case with the richest UI (a link into the tournament). */
export function buildCallStatusView(
  overrides: Partial<Extract<CallStatusView, { kind: "awaiting_call" }>> = {},
): Extract<CallStatusView, { kind: "awaiting_call" }> {
  return {
    kind: "awaiting_call",
    tournamentId: "t-1",
    tournamentName: "Summer Smash",
    eventName: "Open Singles",
    canEdit: true,
    ...overrides,
  };
}

/** Props for `CallStatusBannerDisplay`. */
export function buildCallStatusBannerDisplayProps(
  overrides: Partial<CallStatusBannerDisplayProps> = {},
): CallStatusBannerDisplayProps {
  return { callStatus: buildCallStatusView(), ...overrides };
}
