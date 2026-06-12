import { render, screen, type Container } from "@/test/utilities";

import { HeroScore, type HeroScoreProps } from "./hero-score";
import { buildHeroScoreProps } from "./hero-score.factory";

const scoped = (container: Container) => ({
  /** One side's games-won number in the scoreline; absent before the match
   * starts (the block shows the VS placeholder instead). */
  getScore(pos: "l" | "r") {
    return container.getByText(/^\d+$/, {
      selector: `.md-hero__score--${pos}`,
    });
  },
  queryScore(pos: "l" | "r") {
    return container.queryByText(/^\d+$/, {
      selector: `.md-hero__score--${pos}`,
    });
  },
  /** The "VS" placeholder shown before the match starts; absent once a
   * scoreline exists. */
  getVsLabel() {
    return container.getByText("VS");
  },
  queryVsLabel() {
    return container.queryByText("VS");
  },
  /** The status line under the VS placeholder (e.g. "Awaiting opponent"). */
  getVsStatusLabel(label: string) {
    return container.getByText(label, { selector: ".md-hero__vs-label" });
  },
});

/**
 * Test page-object for `HeroScore` — the center block of the hero row:
 * either the pre-match "VS · <status>" placeholder or the games-won
 * scoreline.
 */
export const heroScorePage = {
  render(overrides: Partial<HeroScoreProps> = {}) {
    const props = buildHeroScoreProps(overrides);
    render(<HeroScore {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component (the hero
   * row and the scoreboard above it) spread this to expose the same queries
   * as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
