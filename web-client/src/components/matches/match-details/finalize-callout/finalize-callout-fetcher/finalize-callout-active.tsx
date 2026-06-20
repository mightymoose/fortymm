import { useRef } from "react";

import { useFinalizeMatch } from "@/api/matches";
import { ApiError } from "@/api/client";

import { FinalizeCalloutDisplay } from "./finalize-callout-active/finalize-callout-display";
import type { FinalizeCalloutView } from "./finalize-callout-query";

export interface FinalizeCalloutActiveProps {
  view: FinalizeCalloutView;
  matchId: string;
}

/** Wires the post-result mutation onto the pure display: posting the view's
 * canonical games, surfacing pending state, and keeping API failures visible
 * inline (without throwOnError a 409 — opponent confirmed first, double-click,
 * etc. — would otherwise vanish and the button would appear inert). */
export function FinalizeCalloutActive({
  view,
  matchId,
}: FinalizeCalloutActiveProps) {
  const finalizeMutation = useFinalizeMatch(matchId);
  const error =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null;
  // Synchronous double-submit guard. `disabled={pending}` only takes effect on
  // the next render, so a fast double-click lands a second tap before React
  // commits the disable — firing two concurrent POST /results that pile up on
  // the backend (issue #641). This ref flips inside the click gesture, so the
  // second tap is rejected regardless of render timing; `onSettled` clears it
  // so a genuine retry after a failure still works.
  const inFlightRef = useRef(false);
  return (
    <FinalizeCalloutDisplay
      pending={finalizeMutation.isPending}
      errorMessage={error ? (error.detail ?? error.message) : null}
      onPost={() => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        finalizeMutation.reset();
        finalizeMutation.mutate(
          { games: view.games },
          {
            onSettled: () => {
              inFlightRef.current = false;
            },
          },
        );
      }}
    />
  );
}
