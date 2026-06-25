import { useSuspenseQuery } from "@tanstack/react-query";

import { DisputeNoticeDisplay } from "./dispute-notice-fetcher/dispute-notice-display";
import { disputeNoticeQuery } from "./dispute-notice-fetcher/dispute-notice-query";

export interface DisputeNoticeProps {
  matchId: string;
}

export function DisputeNoticeFetcher({ matchId }: DisputeNoticeProps) {
  const { data: view } = useSuspenseQuery(disputeNoticeQuery(matchId));
  // A null projection means the notice doesn't apply to this viewer — the
  // match isn't disputed, they're the disputer, or they're a spectator.
  if (!view) return null;
  return <DisputeNoticeDisplay view={view} />;
}
