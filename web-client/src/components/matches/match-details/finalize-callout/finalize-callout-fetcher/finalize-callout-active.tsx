import { useRef } from "react";

import { useProposeResult } from "@/api/matches";
import { ApiError } from "@/api/client";

import { FinalizeCalloutDisplay } from "./finalize-callout-active/finalize-callout-display";
import type { FinalizeCalloutView } from "./finalize-callout-query";

export interface FinalizeCalloutActiveProps {
  view: FinalizeCalloutView;
  matchId: string;
}

const CONNECTION_COPY =
  "Couldn't post the result — check your connection and try again.";
// Last-resort copy for an `ApiError` carrying an empty `detail` AND `message`,
// so an error state can never render as a silent, dead button.
const API_FALLBACK = "Couldn't post the result — try again.";

/** Wires the post-result mutation onto the pure display: posting the view's
 * canonical games, surfacing pending state, and keeping API failures visible
 * inline (without throwOnError a 409 — opponent confirmed first, double-click,
 * etc. — would otherwise vanish and the button would appear inert). */
export function FinalizeCalloutActive({
  view,
  matchId,
}: FinalizeCalloutActiveProps) {
  const finalizeMutation = useProposeResult(matchId);
  // A 409 (opponent confirmed first, double-click, etc.) or any other server
  // rejection arrives as an `ApiError` carrying the server's `detail` copy.
  const apiError =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null;
  // A non-ApiError needs its own branch: `useProposeResult` runs
  // `networkMode: 'always'`, so an offline (or mid-flight-dropped) submit fires
  // the POST anyway and `fetch` rejects at the transport level with a plain
  // `TypeError` — never an `ApiError`. Without this, a dropped send would just
  // re-enable the button with no feedback at all, and there's no other
  // affordance on this callout to explain the dead button (#867). Mutually
  // exclusive with `apiError` by construction (the error is one or the other,
  // never both).
  const networkError = finalizeMutation.error !== null && apiError === null;
  // `||`, NOT `??`: the display gates the alert on `{errorMessage && …}`, so any
  // falsy string renders nothing. `extractDetail` passes a server `detail`
  // through verbatim, and `ApiError`'s `super(detail ?? …)` leaves `message`
  // empty too when `detail` is `""` — so a `{"detail": ""}` rejection would
  // reduce to `""` under `??` and re-enable the button with no feedback, the
  // same dead-button shape #867 was about. No results-path error emits an empty
  // detail today, so this is defence-in-depth rather than a live bug; `||` skips
  // an empty `detail`/`message` to a guaranteed non-empty fallback and makes the
  // invariant local — an error state always renders some copy — instead of
  // resting on every server message staying non-empty forever.
  const errorMessage = networkError
    ? CONNECTION_COPY
    : apiError
      ? (apiError.detail || apiError.message || API_FALLBACK)
      : null;
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
      errorMessage={errorMessage}
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
