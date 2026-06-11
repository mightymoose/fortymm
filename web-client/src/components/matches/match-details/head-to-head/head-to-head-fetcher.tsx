import { useSuspenseQuery } from "@tanstack/react-query";

import { HeadToHeadDisplay } from "./head-to-head-display";
import { headToHeadQuery } from "./head-to-head-query";

export interface HeadToHeadProps {
  matchId: string;
}

export function HeadToHeadFetcher({ matchId }: HeadToHeadProps) {
  const { data: headToHead } = useSuspenseQuery(headToHeadQuery(matchId));

  // A null projection means there's no shared record to show — the match
  // carries no head-to-head payload.
  if (!headToHead) return null;
  return <HeadToHeadDisplay headToHead={headToHead} />;
}
