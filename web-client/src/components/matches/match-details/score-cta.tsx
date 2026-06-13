import { Suspense } from "react";

import { ScoreCtaFetcher } from "./score-cta/score-cta-fetcher";

export interface ScoreCtaProps {
  matchId: string;
}

/** The header's "Score" CTA: deep-links the viewer into score entry for the
 * match's current game. Self-fetching; renders nothing when there's nothing
 * to score (spectator, or no open game). */
export function ScoreCta({ matchId }: ScoreCtaProps) {
  return (
    <Suspense fallback={null}>
      <ScoreCtaFetcher matchId={matchId} />
    </Suspense>
  );
}
