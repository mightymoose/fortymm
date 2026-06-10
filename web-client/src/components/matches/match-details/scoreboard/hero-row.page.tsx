import { render, screen, type Container } from "@/test/utilities";

import { heroPlayerPage } from "./hero-player.page";
import { heroScorePage } from "./hero-score.page";
import { HeroRow, type HeroRowProps } from "./hero-row";
import { buildHeroRowProps } from "./hero-row.factory";

const scoped = (container: Container) => ({
  // The row is its two players plus the score block — reuse their queries
  // as this component's own surface.
  ...heroPlayerPage.within(container),
  ...heroScorePage.within(container),
});

/**
 * Test page-object for `HeroRow` — the hero strip's left player / score
 * block / right player. Player accessors take the `pos` end of the row
 * (`"l"`/`"r"`); score accessors mirror `heroScorePage`.
 */
export const heroRowPage = {
  render(overrides: Partial<HeroRowProps> = {}) {
    const props = buildHeroRowProps(overrides);
    render(<HeroRow {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed the hero row (the
   * scoreboard display, fetcher, and wrapper) call this to expose the same
   * player/score queries as their own `.heroRow`, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
