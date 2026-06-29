import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAcceptResult } from "@/api/matches";
import { ApiError } from "@/api/client";

import { matchDetailsQueryKey } from "../../match-details-query";
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
  const queryClient = useQueryClient();
  const acceptMutation = useAcceptResult(matchId);
  const error =
    acceptMutation.error instanceof ApiError ? acceptMutation.error : null;
  // A 409 means the standing result moved on between render and click — the
  // opponent posted a correction the viewer never re-reviewed (#726). Don't
  // silently retarget the live result; surface the correction-path "reload to
  // re-review" prompt so accepting stays a conscious act on a seen score.
  const staleConflict = error?.status === 409;
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
      staleConflict={staleConflict}
      // A 409 has dedicated reload copy + button; only surface other failures
      // as the raw inline message.
      errorMessage={
        error && !staleConflict ? (error.detail ?? error.message) : null
      }
      onReload={() => {
        acceptMutation.reset();
        inFlightRef.current = false;
        void queryClient.invalidateQueries({
          queryKey: matchDetailsQueryKey(matchId),
        });
      }}
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
