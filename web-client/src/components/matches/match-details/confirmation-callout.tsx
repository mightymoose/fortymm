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
    <Suspense fallback={<div>Loading...</div>}>
      <ConfirmationCalloutFetcher matchId={matchId} />
    </Suspense>
  );
}
