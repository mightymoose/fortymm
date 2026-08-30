import { Suspense } from "react";

import { CallStatusBannerFetcher } from "./call-status-banner/call-status-banner-fetcher";

export interface CallStatusBannerProps {
  matchId: string;
}

/** The match page's "why can't I score this yet" banner (#1288). Self-
 * fetching; renders nothing while pending or once resolved when the match is
 * scorable (or a casual match, which has nothing to say). */
export function CallStatusBanner({ matchId }: CallStatusBannerProps) {
  return (
    <Suspense fallback={null}>
      <CallStatusBannerFetcher matchId={matchId} />
    </Suspense>
  );
}
