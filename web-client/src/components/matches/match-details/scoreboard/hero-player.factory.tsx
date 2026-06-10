import type { HeroPlayerProps } from "./hero-player";
import type { HeroSideView } from "./scoreboard-query";

/** A named side ("rita.kovac") that hasn't won — a match still in play. */
export function buildHeroSideView(
  overrides: Partial<HeroSideView> = {},
): HeroSideView {
  return {
    name: "rita.kovac",
    initials: "RK",
    isGhost: false,
    won: false,
    ...overrides,
  };
}

/** A ghost "No opponent" side — the dashed placeholder for a solo match. */
export function buildGhostHeroSideView(
  overrides: Partial<HeroSideView> = {},
): HeroSideView {
  return {
    name: "No opponent",
    initials: "NO",
    isGhost: true,
    won: false,
    ...overrides,
  };
}

/** Props for `HeroPlayer` — rita.kovac anchoring the left end of the row. */
export function buildHeroPlayerProps(
  overrides: Partial<HeroPlayerProps> = {},
): HeroPlayerProps {
  return {
    side: buildHeroSideView(),
    pos: "l",
    ...overrides,
  };
}
