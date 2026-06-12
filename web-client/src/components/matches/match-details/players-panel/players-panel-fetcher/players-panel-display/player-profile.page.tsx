import { render, screen, type Container } from "@/test/utilities";

import { careerStatsPage } from "./player-profile/career-stats.page";
import { PlayerProfile, type PlayerProfileProps } from "./player-profile";
import { buildPlayerProfileProps } from "./player-profile.factory";
import { ratingBoxPage } from "./player-profile/rating-box.page";
import { recentFormPage } from "./player-profile/recent-form.page";

const scoped = (container: Container) => ({
  /** The profile's player-name line. */
  getName(name: string) {
    return container.getByText(name, { selector: ".md-profile__name" });
  },
  queryName(name: string) {
    return container.queryByText(name, { selector: ".md-profile__name" });
  },
  /** The initials avatar — win/loss toned by the profile's `won`. */
  getAvatar(initials: string) {
    return container.getByText(initials, { selector: ".md-avatar" });
  },
  /** The pre-match rating box at the top of the profile. */
  ...ratingBoxPage.within(container),
  /** The recent-form block in the middle. */
  ...recentFormPage.within(container),
  /** The career strip at the bottom. */
  ...careerStatsPage.within(container),
});

/**
 * Test page-object for `PlayerProfile` — one player's half of the snapshot
 * panel (identity, rating box, recent form, career strip). The child page
 * objects' queries are spread in, so callers read rating/form/career through
 * the same accessors the children's own tests use.
 */
export const playerProfilePage = {
  render(overrides: Partial<PlayerProfileProps> = {}) {
    const props = buildPlayerProfileProps(overrides);
    render(<PlayerProfile {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The panel display's page object scopes this to
   * one profile at a time via `profileFor(name)`.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
