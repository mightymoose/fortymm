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
    <Suspense fallback={<div>Loading...</div>}>
      <FinalizeCalloutFetcher matchId={matchId} />
    </Suspense>
  );
}
