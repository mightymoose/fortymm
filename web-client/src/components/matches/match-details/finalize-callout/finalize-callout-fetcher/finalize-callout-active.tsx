import { useRef } from "react";

import { useProposeResult } from "@/api/matches";
import { ApiError } from "@/api/client";

import { FinalizeCalloutDisplay } from "./finalize-callout-active/finalize-callout-display";
import type { FinalizeCalloutView } from "./finalize-callout-query";

export interface FinalizeCalloutActiveProps {
  view: FinalizeCalloutView;
  matchId: string;
}

// Last-resort copy for an `ApiError` whose `detail` AND `message` are both
// empty. Guarantees the invariant: whenever the mutation is in an error state,
// some non-empty copy renders — never a dead button (#867).
const API_FALLBACK = "Couldn't post the result — try again.";
const CONNECTION_COPY =
  "Couldn't post the result — check your connection and try again.";

/** Wires the post-result mutation onto the pure display: posting the view's
 * canonical games, surfacing pending state, and keeping failures visible inline
 * — both API rejections (without throwOnError a 409 — opponent confirmed first,
 * double-click, etc. — would otherwise vanish and the button would appear
 * inert) and transport-level ones (an offline send, #867). */
export function FinalizeCalloutActive({
  view,
  matchId,
}: FinalizeCalloutActiveProps) {
  const finalizeMutation = useProposeResult(matchId);
  const apiError =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null;

  // A non-ApiError needs its own branch: `useProposeResult` runs
  // `networkMode: 'always'`, so an offline submit fires the POST anyway and
  // `fetch` rejects at the transport level with a plain `TypeError` — never an
  // `ApiError`. Without this, an offline send would re-enable the button with
  // no feedback at all (#867). Mutually exclusive with `apiError` by
  // construction (the error is one or the other, never both).
  const networkError = finalizeMutation.error !== null && apiError === null;
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
      errorMessage={
        apiError
          ? // `||`, NOT `??`: an empty-string `detail` is falsy, and the display
            // gates the alert on `{errorMessage && …}`, so a `??` fallback would
            // pass `""` through and silently suppress the alert — the button
            // returns to "Post result" with zero feedback, reintroducing #867 on
            // the API branch. `||` skips over an empty `detail`/`message` to a
            // guaranteed non-empty fallback.
            (apiError.detail || apiError.message || API_FALLBACK)
          : networkError
            ? CONNECTION_COPY
            : null
      }
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
