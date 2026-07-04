import { Suspense } from "react";

import { ConfirmationCalloutFetcher } from "./confirmation-callout/confirmation-callout-fetcher";

export interface ConfirmationCalloutProps {
  matchId: string;
}

/** The posted-result acceptance callout: featured Accept/Suggest-correction
 * CTAs when it's the viewer's turn to respond, or the passive
 * "Awaiting <opponent>" notice once they've posted. Self-fetching; renders
 * nothing when neither state applies. */
export function ConfirmationCallout({ matchId }: ConfirmationCalloutProps) {
  return (
    // Renders nothing when no acceptance is in play, so a visible skeleton would
    // flash then collapse. A visually-hidden status keeps the load announced
    // (and tests a sync handle) while reserving no space.
    <Suspense
      fallback={
        <span
          className="sr-only"
          role="status"
          aria-busy="true"
          aria-label="Loading the result acceptance prompt"
        />
      }
    >
      <ConfirmationCalloutFetcher matchId={matchId} />
    </Suspense>
  );
}
