import type { components } from "@/api/schema";

import type { ConfirmationCalloutDisplayProps } from "./confirmation-callout-display";
import type { ConfirmationCalloutView } from "../confirmation-callout-query";

type NegotiationDiffEntry = components["schemas"]["NegotiationDiffEntry"];

/** The review variant: the opponent posted the first result; the viewer can
 * Accept or suggest a correction. Carries the standing result's acceptance
 * token + the rated stakes. */
export function buildReviewConfirmationView(
  overrides: Partial<Extract<ConfirmationCalloutView, { kind: "review" }>> = {},
): ConfirmationCalloutView {
  return { kind: "review", resultId: "r-1", rated: true, ...overrides };
}

/** A two-game diff (one changed game + one newly-added game), mirroring the
 * server-computed `negotiation.diff` shape. */
export function buildCorrectionDiff(): NegotiationDiffEntry[] {
  return [
    {
      game_number: 1,
      old: { game_number: 1, side_1_points: 11, side_2_points: 7 },
      new: { game_number: 1, side_1_points: 11, side_2_points: 9 },
    },
    {
      game_number: 2,
      old: null,
      new: { game_number: 2, side_1_points: 11, side_2_points: 5 },
    },
  ];
}

/** The corrected variant: the opponent countered the viewer's prior proposal;
 * the callout shows the diff + Accept/Counter. */
export function buildCorrectedConfirmationView(
  overrides: Partial<
    Extract<ConfirmationCalloutView, { kind: "corrected" }>
  > = {},
): ConfirmationCalloutView {
  return {
    kind: "corrected",
    resultId: "r-2",
    rated: true,
    diff: buildCorrectionDiff(),
    ...overrides,
  };
}

/** The passive awaiting variant: the viewer has posted, leo.mertens hasn't
 * accepted. */
export function buildAwaitingConfirmationView(
  overrides: Partial<
    Extract<ConfirmationCalloutView, { kind: "awaiting" }>
  > = {},
): ConfirmationCalloutView {
  return {
    kind: "awaiting",
    pendingSignerName: "leo.mertens",
    ...overrides,
  };
}

/** Props for `ConfirmationCalloutDisplay` — the review variant, idle (nothing
 * pending, no error). */
export function buildConfirmationCalloutDisplayProps(
  overrides: Partial<ConfirmationCalloutDisplayProps> = {},
): ConfirmationCalloutDisplayProps {
  return {
    view: buildReviewConfirmationView(),
    matchId: "m-1",
    acceptPending: false,
    staleConflict: false,
    errorMessage: null,
    onAccept: () => {},
    onReload: () => {},
    ...overrides,
  };
}
