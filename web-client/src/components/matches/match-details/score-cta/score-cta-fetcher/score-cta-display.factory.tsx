import type { ScoreCtaView } from "./score-cta-query";
import type { ScoreCtaDisplayProps } from "./score-cta-display";

/** A scorable match: game 1 of `match-1` is open and the viewer can score it. */
export function buildScoreCtaView(
  overrides: Partial<ScoreCtaView> = {},
): ScoreCtaView {
  return {
    matchId: "match-1",
    gameNumber: 1,
    ...overrides,
  };
}

/** Props for `ScoreCtaDisplay`. */
export function buildScoreCtaDisplayProps(
  overrides: Partial<ScoreCtaDisplayProps> = {},
): ScoreCtaDisplayProps {
  return {
    scoreCta: buildScoreCtaView(),
    ...overrides,
  };
}
