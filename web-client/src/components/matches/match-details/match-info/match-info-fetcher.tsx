import { useSuspenseQuery } from "@tanstack/react-query";

import { MatchInfoDisplay } from "./match-info-fetcher/match-info-display";
import { matchInfoQuery } from "./match-info-fetcher/match-info-query";

export interface MatchInfoProps {
  matchId: string;
}

export function MatchInfoFetcher({ matchId }: MatchInfoProps) {
  const { data: info } = useSuspenseQuery(matchInfoQuery(matchId));

  return <MatchInfoDisplay info={info} />;
}
