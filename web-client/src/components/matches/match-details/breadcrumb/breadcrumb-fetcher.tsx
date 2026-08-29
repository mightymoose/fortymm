import { useSuspenseQuery } from "@tanstack/react-query";

import { BreadcrumbDisplay } from "./breadcrumb-fetcher/breadcrumb-display";
import { breadcrumbQuery } from "./breadcrumb-fetcher/breadcrumb-query";

export interface BreadcrumbFetcherProps {
  matchId: string;
}

export function BreadcrumbFetcher({ matchId }: BreadcrumbFetcherProps) {
  const { data: tournament } = useSuspenseQuery(breadcrumbQuery(matchId));
  return <BreadcrumbDisplay matchId={matchId} tournament={tournament} />;
}
