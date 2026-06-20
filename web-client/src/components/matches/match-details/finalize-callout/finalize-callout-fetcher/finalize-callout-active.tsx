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
  // second tap is rejected regardless of render timing.
  //
  // Cleared on *error* only, never on success. A successful post transitions
  // the match to awaiting-confirmation and unmounts this callout, so the guard
  // never needs to reopen on success; clearing on settle instead would reopen
  // it the instant the request resolves — a beat before that unmount lands —
  // leaving a window where a rapid second click still fires a duplicate 409.
  // Clearing on error keeps the guard shut through that window while still
  // letting a genuine retry fire after a failure.
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
            onError: () => {
              inFlightRef.current = false;
            },
          },
        );
      }}
    />
  );
}
