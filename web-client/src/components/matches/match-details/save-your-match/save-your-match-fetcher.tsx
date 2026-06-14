import { useSuspenseQuery } from "@tanstack/react-query";

import { SaveYourMatchDisplay } from "./save-your-match-fetcher/save-your-match-display";
import { saveYourMatchQuery } from "./save-your-match-fetcher/save-your-match-query";

export interface SaveYourMatchProps {
  matchId: string;
}

export function SaveYourMatchFetcher({ matchId }: SaveYourMatchProps) {
  const { data: view } = useSuspenseQuery(saveYourMatchQuery(matchId));
  // A null projection means the prompt doesn't apply (match not yet started,
  // the viewer isn't a participant, or there's no real opponent). We bail here,
  // before the display, so we never call useSession() — and thereby mint a
  // guest user via GET /v1/session — when the prompt isn't going to render.
  if (!view) return null;
  return <SaveYourMatchDisplay view={view} matchId={matchId} />;
}
