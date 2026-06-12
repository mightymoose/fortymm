import { useSuspenseQuery } from "@tanstack/react-query";

import { ConfirmationCalloutActive } from "./confirmation-callout-fetcher/confirmation-callout-active";
import { confirmationCalloutQuery } from "./confirmation-callout-fetcher/confirmation-callout-query";

export interface ConfirmationCalloutProps {
  matchId: string;
}

export function ConfirmationCalloutFetcher({
  matchId,
}: ConfirmationCalloutProps) {
  const { data: view } = useSuspenseQuery(confirmationCalloutQuery(matchId));
  // A null projection means there's no sign-off in play for this viewer —
  // the callout doesn't apply.
  if (!view) return null;
  return <ConfirmationCalloutActive view={view} matchId={matchId} />;
}
