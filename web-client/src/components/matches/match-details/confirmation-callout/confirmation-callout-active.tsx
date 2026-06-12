import { useConfirmMatch, useDisputeMatch } from "@/api/matches";
import { ApiError } from "@/api/client";

import { ConfirmationCalloutDisplay } from "./confirmation-callout-display";
import type { ConfirmationCalloutView } from "./confirmation-callout-query";

export interface ConfirmationCalloutActiveProps {
  view: ConfirmationCalloutView;
  matchId: string;
}

/** Wires the confirm/dispute mutations onto the pure display. Each CTA resets
 * the *other* mutation first so a stale failure doesn't linger once the user
 * changes course, and API failures stay visible inline (without throwOnError a
 * 409 — opponent confirmed/disputed first, double-click, etc. — would
 * otherwise vanish and the buttons would appear inert). */
export function ConfirmationCalloutActive({
  view,
  matchId,
}: ConfirmationCalloutActiveProps) {
  const confirmMutation = useConfirmMatch(matchId);
  const disputeMutation = useDisputeMatch(matchId);
  const error =
    (confirmMutation.error instanceof ApiError
      ? confirmMutation.error
      : null) ??
    (disputeMutation.error instanceof ApiError ? disputeMutation.error : null);
  return (
    <ConfirmationCalloutDisplay
      view={view}
      confirmPending={confirmMutation.isPending}
      disputePending={disputeMutation.isPending}
      errorMessage={error ? (error.detail ?? error.message) : null}
      onConfirm={() => {
        disputeMutation.reset();
        confirmMutation.mutate();
      }}
      onDispute={() => {
        confirmMutation.reset();
        disputeMutation.mutate();
      }}
    />
  );
}
