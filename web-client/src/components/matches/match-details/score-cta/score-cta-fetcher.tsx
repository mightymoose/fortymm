import { useSuspenseQuery } from "@tanstack/react-query";

import { ScoreCtaDisplay } from "./score-cta-fetcher/score-cta-display";
import { scoreCtaQuery } from "./score-cta-fetcher/score-cta-query";

export interface ScoreCtaProps {
  matchId: string;
}

export function ScoreCtaFetcher({ matchId }: ScoreCtaProps) {
  const { data: scoreCta } = useSuspenseQuery(scoreCtaQuery(matchId));
  // A null projection means there's nothing to score right now — the CTA
  // doesn't apply.
  if (!scoreCta) return null;
  return <ScoreCtaDisplay scoreCta={scoreCta} />;
}
