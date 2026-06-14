import { Suspense } from "react";

import { ConfirmationCalloutFetcher } from "./confirmation-callout/confirmation-callout-fetcher";

export interface ConfirmationCalloutProps {
  matchId: string;
}

/** The posted-result sign-off callout: featured Confirm/Dispute CTAs when the
 * viewer's signature is the one missing, or the passive "Awaiting <opponent>"
 * notice once they've signed. Self-fetching; renders nothing when neither
 * state applies. */
export function ConfirmationCallout({ matchId }: ConfirmationCalloutProps) {
  return (
    // Renders nothing when no sign-off is in play, so a visible skeleton would
    // flash then collapse. A visually-hidden status keeps the load announced
    // (and tests a sync handle) while reserving no space.
    <Suspense
      fallback={
        <span className="sr-only" role="status">
          Loading result actions
        </span>
      }
    >
      <ConfirmationCalloutFetcher matchId={matchId} />
    </Suspense>
  );
}
