import { Suspense } from "react";

import { DisputeNoticeFetcher } from "./dispute-notice/dispute-notice-fetcher";

export interface DisputeNoticeProps {
  matchId: string;
}

/** The "your opponent disputed your result" notice shown to the submitter on a
 * disputed match, telling them to re-score and re-post. Self-fetching; renders
 * nothing when the viewer isn't the submitter of a disputed result (#360). */
export function DisputeNotice({ matchId }: DisputeNoticeProps) {
  return (
    // Renders nothing on a non-disputed match, so a visible skeleton would
    // flash then collapse. A visually-hidden status keeps the load announced
    // while reserving no space — mirrors the confirmation callout wrapper.
    <Suspense
      fallback={
        <span
          className="sr-only"
          role="status"
          aria-busy="true"
          aria-label="Loading the dispute notice"
        />
      }
    >
      <DisputeNoticeFetcher matchId={matchId} />
    </Suspense>
  );
}
