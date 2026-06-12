import type { HeroScoreProps } from "./hero-score";
import type { HeroScoreView } from "../../scoreboard-query";

/** A live scoreline with the left side ahead 2–1, nothing decided yet. */
export function buildScorelineHeroScoreView(
  overrides: Partial<Extract<HeroScoreView, { kind: "scoreline" }>> = {},
): HeroScoreView {
  return {
    kind: "scoreline",
    left: { gamesWon: 2, won: false },
    right: { gamesWon: 1, won: false },
    ...overrides,
  };
}

/** The pre-match "VS" placeholder with its status line. */
export function buildUpcomingHeroScoreView(
  overrides: Partial<Extract<HeroScoreView, { kind: "upcoming" }>> = {},
): HeroScoreView {
  return {
    kind: "upcoming",
    statusLabel: "Awaiting opponent",
    ...overrides,
  };
}

/** Props for `HeroScore` — a live 2–1 scoreline. */
export function buildHeroScoreProps(
  overrides: Partial<HeroScoreProps> = {},
): HeroScoreProps {
  return {
    score: buildScorelineHeroScoreView(),
    ...overrides,
  };
}
