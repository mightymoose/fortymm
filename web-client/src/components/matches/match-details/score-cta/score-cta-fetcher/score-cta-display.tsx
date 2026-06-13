import { Link } from "@tanstack/react-router";

import { scoringNewRoute } from "@/api/matches";

import { type ScoreCtaView } from "./score-cta-query";

export interface ScoreCtaDisplayProps {
  scoreCta: ScoreCtaView;
}

/** The header's primary "Score" button — a typed link into the score-entry
 * route for the match's current game. */
export const ScoreCtaDisplay = ({ scoreCta }: ScoreCtaDisplayProps) => {
  return (
    <Link
      {...scoringNewRoute(scoreCta.matchId, scoreCta.gameNumber)}
      className="md-btn md-btn--primary md-btn--sm"
    >
      Score
    </Link>
  );
};
