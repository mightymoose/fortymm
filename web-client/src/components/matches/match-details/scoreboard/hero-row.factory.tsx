import { buildHeroSideView } from "./hero-player.factory";
import { buildScorelineHeroScoreView } from "./hero-score.factory";
import type { HeroRowProps } from "./hero-row";
import type { HeroRowView } from "./scoreboard-query";

/** A live BO5: rita.kovac (left) leading leo.mertens (right) 2 games to 1. */
export function buildHeroRowView(
  overrides: Partial<HeroRowView> = {},
): HeroRowView {
  return {
    left: buildHeroSideView(),
    score: buildScorelineHeroScoreView(),
    right: buildHeroSideView({ name: "leo.mertens", initials: "LM" }),
    ...overrides,
  };
}

/** Props for `HeroRow`. */
export function buildHeroRowProps(
  overrides: Partial<HeroRowProps> = {},
): HeroRowProps {
  return {
    heroRow: buildHeroRowView(),
    ...overrides,
  };
}
