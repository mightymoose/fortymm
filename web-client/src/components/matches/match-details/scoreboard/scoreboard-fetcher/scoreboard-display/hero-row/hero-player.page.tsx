import { render, screen, type Container } from "@/test/utilities";

import { HeroPlayer, type HeroPlayerProps } from "./hero-player";
import { buildHeroPlayerProps } from "./hero-player.factory";

const scoped = (container: Container) => ({
  /**
   * The side's name element, resolved within the `--l`/`--r` positioned
   * block; a ghost side reads "No opponent". Absent when no side with that
   * name sits at that end of the row.
   */
  getPlayerName(pos: "l" | "r", name: string) {
    return container.getByText(name, {
      selector: `.md-hero__player--${pos} .md-hero__player-text--${pos} .md-hero__name`,
    });
  },
  queryPlayerName(pos: "l" | "r", name: string) {
    return container.queryByText(name, {
      selector: `.md-hero__player--${pos} .md-hero__player-text--${pos} .md-hero__name`,
    });
  },
  /** The initials avatar badge; ghost sides render an icon-only placeholder
   * with no initials, so this is absent for them. */
  getPlayerAvatar(initials: string) {
    return container.getByText(initials, {
      selector: ".md-hero__avatar-singles",
    });
  },
  queryPlayerAvatar(initials: string) {
    return container.queryByText(initials, {
      selector: ".md-hero__avatar-singles",
    });
  },
});

/**
 * Test page-object for `HeroPlayer` — one side of the hero row (avatar +
 * name, or the ghost "No opponent" placeholder). Accessors take the `pos`
 * the component was given, mirroring how the row distinguishes its two ends.
 */
export const heroPlayerPage = {
  render(overrides: Partial<HeroPlayerProps> = {}) {
    const props = buildHeroPlayerProps(overrides);
    render(<HeroPlayer {...props} />);
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
