import { useSuspenseQuery } from "@tanstack/react-query";

import { FinalizeCalloutActive } from "./finalize-callout-active";
import { finalizeCalloutQuery } from "./finalize-callout-query";

export interface FinalizeCalloutProps {
  matchId: string;
}

export function FinalizeCalloutFetcher({ matchId }: FinalizeCalloutProps) {
  const { data: view } = useSuspenseQuery(finalizeCalloutQuery(matchId));
  // A null projection means there's nothing postable (no decided, unsigned
  // board) — the callout doesn't apply.
  if (!view) return null;
  return <FinalizeCalloutActive view={view} matchId={matchId} />;
}
