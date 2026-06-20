import { useRef } from "react";

import { useConfirmMatch, useDisputeMatch } from "@/api/matches";
import { ApiError } from "@/api/client";

import { ConfirmationCalloutDisplay } from "./confirmation-callout-active/confirmation-callout-display";
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
  // Synchronous double-submit guard shared by both CTAs. `disabled={pending}`
  // only takes effect on the next render, so a fast double-click — on either
  // button — lands a second tap before React commits the disable and fires a
  // duplicate POST that 409s (the loser of the row-lock race). One ref covers
  // both: confirm and dispute are mutually exclusive, and the display already
  // disables both while either is pending, so the first action wins until it
  // settles. `onSettled` clears it so the user can still change course (e.g.
  // confirm after a failed dispute) once the first attempt resolves.
  const inFlightRef = useRef(false);
  return (
    <ConfirmationCalloutDisplay
      view={view}
      confirmPending={confirmMutation.isPending}
      disputePending={disputeMutation.isPending}
      errorMessage={error ? (error.detail ?? error.message) : null}
      onConfirm={() => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        disputeMutation.reset();
        confirmMutation.mutate(undefined, {
          onSettled: () => {
            inFlightRef.current = false;
          },
        });
      }}
      onDispute={() => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        confirmMutation.reset();
        disputeMutation.mutate(undefined, {
          onSettled: () => {
            inFlightRef.current = false;
          },
        });
      }}
    />
  );
}
