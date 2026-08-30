import { useSuspenseQuery } from "@tanstack/react-query";

import { CallStatusBannerDisplay } from "./call-status-banner-fetcher/call-status-banner-display";
import { callStatusQuery } from "./call-status-banner-fetcher/call-status-banner-query";

export interface CallStatusBannerProps {
  matchId: string;
}

export function CallStatusBannerFetcher({ matchId }: CallStatusBannerProps) {
  const { data: callStatus } = useSuspenseQuery(callStatusQuery(matchId));
  return <CallStatusBannerDisplay callStatus={callStatus} />;
}
