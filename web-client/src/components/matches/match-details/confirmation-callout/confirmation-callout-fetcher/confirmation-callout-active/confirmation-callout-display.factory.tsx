import type { ConfirmationCalloutDisplayProps } from "./confirmation-callout-display";
import type { ConfirmationCalloutView } from "../confirmation-callout-query";

/** The featured variant: the opponent's standing proposal awaits the viewer's
 * acceptance. Carries the standing result's id (the acceptance token). */
export function buildActionableConfirmationView(
  overrides: Partial<Extract<ConfirmationCalloutView, { kind: "actionable" }>> = {},
): ConfirmationCalloutView {
  return { kind: "actionable", resultId: "r-1", ...overrides };
}

/** The passive variant: the viewer has posted, leo.mertens hasn't accepted. */
export function buildAwaitingConfirmationView(
  overrides: Partial<Extract<ConfirmationCalloutView, { kind: "awaiting" }>> = {},
): ConfirmationCalloutView {
  return {
    kind: "awaiting",
    pendingSignerName: "leo.mertens",
    ...overrides,
  };
}

/** Props for `ConfirmationCalloutDisplay` — the actionable variant, idle
 * (nothing pending, no error). */
export function buildConfirmationCalloutDisplayProps(
  overrides: Partial<ConfirmationCalloutDisplayProps> = {},
): ConfirmationCalloutDisplayProps {
  return {
    view: buildActionableConfirmationView(),
    acceptPending: false,
    errorMessage: null,
    onAccept: () => {},
    ...overrides,
  };
}
