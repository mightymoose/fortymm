import { Suspense } from "react";

import { SaveYourMatchFetcher } from "./save-your-match/save-your-match-fetcher";

export interface SaveYourMatchProps {
  matchId: string;
}

/** The guest "save this match" nudge: prompts a cookie-only guest to attach an
 * email so their rating and rivalry survive a cookie clear. Self-fetching;
 * renders nothing for a verified user, a spectator, or a match with nothing to
 * save yet. */
export function SaveYourMatch({ matchId }: SaveYourMatchProps) {
  return (
    <Suspense fallback={null}>
      <SaveYourMatchFetcher matchId={matchId} />
    </Suspense>
  );
}
