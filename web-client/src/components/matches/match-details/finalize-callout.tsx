import { Suspense } from "react";

import { FinalizeCalloutFetcher } from "./finalize-callout/finalize-callout-fetcher";

export interface FinalizeCalloutProps {
  matchId: string;
}

/** The "Scores ready · not yet posted" callout: offers a one-click "Post
 * result" when the saved scores already decide the match but no result has
 * been posted. Self-fetching; renders nothing when there's nothing postable. */
export function FinalizeCallout({ matchId }: FinalizeCalloutProps) {
  return (
    // Renders nothing when there's nothing postable, so a visible skeleton
    // would flash then collapse. A visually-hidden status keeps the load
    // announced (and tests a sync handle) while reserving no space.
    <Suspense
      fallback={
        <span
          className="sr-only"
          role="status"
          aria-busy="true"
          aria-label="Loading the post-result prompt"
        />
      }
    >
      <FinalizeCalloutFetcher matchId={matchId} />
    </Suspense>
  );
}
