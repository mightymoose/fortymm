import type { ConfirmationCalloutDisplayProps } from "./confirmation-callout-display";
import type { ConfirmationCalloutView } from "../confirmation-callout-query";

/** The featured variant: a posted result awaiting the viewer's sign-off. */
export function buildActionableConfirmationView(
  overrides: Partial<Extract<ConfirmationCalloutView, { kind: "actionable" }>> = {},
): ConfirmationCalloutView {
  return { kind: "actionable", ...overrides };
}

/** The passive variant: the viewer has posted, leo.mertens hasn't signed.
 * Defaults to the submitter's own view (``canWithdraw`` true). */
export function buildAwaitingConfirmationView(
  overrides: Partial<Extract<ConfirmationCalloutView, { kind: "awaiting" }>> = {},
): ConfirmationCalloutView {
  return {
    kind: "awaiting",
    pendingSignerName: "leo.mertens",
    canWithdraw: true,
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
    confirmPending: false,
    disputePending: false,
    withdrawPending: false,
    errorMessage: null,
    onConfirm: () => {},
    onDispute: () => {},
    onWithdraw: () => {},
    ...overrides,
  };
}
