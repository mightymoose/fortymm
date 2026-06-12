import { useFinalizeMatch } from "@/api/matches";
import { ApiError } from "@/api/client";

import { FinalizeCalloutDisplay } from "./finalize-callout-active/finalize-callout-display";
import type { FinalizeCalloutView } from "./finalize-callout-query";

export interface FinalizeCalloutActiveProps {
  view: FinalizeCalloutView;
  matchId: string;
}

/** Wires the post-result mutation onto the pure display: posting the view's
 * canonical games, surfacing pending state, and keeping API failures visible
 * inline (without throwOnError a 409 — opponent confirmed first, double-click,
 * etc. — would otherwise vanish and the button would appear inert). */
export function FinalizeCalloutActive({
  view,
  matchId,
}: FinalizeCalloutActiveProps) {
  const finalizeMutation = useFinalizeMatch(matchId);
  const error =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null;
  return (
    <FinalizeCalloutDisplay
      pending={finalizeMutation.isPending}
      errorMessage={error ? (error.detail ?? error.message) : null}
      onPost={() => {
        finalizeMutation.reset();
        finalizeMutation.mutate({ games: view.games });
      }}
    />
  );
}
