import { useRef } from "react";

import { useAcceptResult } from "@/api/matches";
import { ApiError } from "@/api/client";

import { ConfirmationCalloutDisplay } from "./confirmation-callout-active/confirmation-callout-display";
import type { ConfirmationCalloutView } from "./confirmation-callout-query";

export interface ConfirmationCalloutActiveProps {
  view: ConfirmationCalloutView;
  matchId: string;
}

/** True for the viewer-must-act states that carry an acceptance token. */
function hasResultId(
  view: ConfirmationCalloutView,
): view is Extract<ConfirmationCalloutView, { resultId: string }> {
  return view.kind === "review" || view.kind === "corrected";
}

/** Wires the accept mutation onto the pure display. The standing result's id is
 * the concurrency token `POST .../acceptance` takes; API failures stay visible
 * inline (without throwOnError a 409 — the proposal moved on, double-click,
 * etc. — would otherwise vanish and the button would appear inert). The passive
 * (`awaiting`/`final`) variants press nothing, so the mutation simply sits idle. */
export function ConfirmationCalloutActive({
  view,
  matchId,
}: ConfirmationCalloutActiveProps) {
  const acceptMutation = useAcceptResult(matchId);
  const error =
    acceptMutation.error instanceof ApiError ? acceptMutation.error : null;
  // Synchronous double-submit guard. `disabled={pending}` only takes effect on
  // the next render, so a fast double-click lands a second tap before React
  // commits the disable and fires a duplicate POST that 409s. Cleared on
  // *error* only, never on success: a successful accept completes the match and
  // unmounts this callout, so clearing on settle would reopen the guard a beat
  // before that unmount lands.
  const inFlightRef = useRef(false);
  return (
    <ConfirmationCalloutDisplay
      view={view}
      matchId={matchId}
      acceptPending={acceptMutation.isPending}
      errorMessage={error ? (error.detail ?? error.message) : null}
      onAccept={() => {
        if (!hasResultId(view)) return;
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        acceptMutation.reset();
        acceptMutation.mutate(view.resultId, {
          onError: () => {
            inFlightRef.current = false;
          },
        });
      }}
    />
  );
}
