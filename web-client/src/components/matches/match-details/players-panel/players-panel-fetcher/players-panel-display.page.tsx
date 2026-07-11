import { render, screen, within, type Container } from "@/test/utilities";

import { noOpponentProfilePage } from "./players-panel-display/no-opponent-profile.page";
import { playerProfilePage } from "./players-panel-display/player-profile.page";
import {
  PlayersPanelDisplay,
  type PlayersPanelDisplayProps,
} from "./players-panel-display";
import { buildPlayersPanelDisplayProps } from "./players-panel-display.factory";

const scoped = (container: Container) => ({
  /** The panel's `<section>` landmark, named by its visible heading. */
  getPanel() {
    return container.getByRole("region", {
      name: "Players · going into this match",
    });
  },
  queryPanel() {
    return container.queryByRole("region", {
      name: "Players · going into this match",
    });
  },
  /** The two-profile grid inside the card body. */
  queryPlayersGrid() {
    return this.getPanel().querySelector(".md-players");
  },
  /** The visible card heading. */
  getTitle() {
    return container.getByRole("heading", {
      level: 3,
      name: "Players · going into this match",
    });
  },
  /** The "SNAPSHOT · …" stamp in the card header's trailing action slot. */
  getSnapshotLabel(text: string) {
    return container.getByText(text, {
      selector: '[data-slot="card-action"]',
    });
  },
  /**
   * One player's half of the panel, scoped by the player's name — the same
   * way a reader tells the two halves apart. Exposes the profile page
   * object's accessors bound to just that half.
   */
  profileFor(name: string) {
    const profile = container
      .getByText(name, { selector: ".md-profile__name" })
      .closest(".md-profile") as HTMLElement;
    return playerProfilePage.within(within(profile) as Container);
  },
  /** The "No opponent" placeholder half; absent with two real players. */
  ...noOpponentProfilePage.within(container),
});

/**
 * Test page-object for `PlayersPanelDisplay` — the pure view-in, DOM-out
 * snapshot card. Use `profileFor(name)` to assert within one half.
 */
export const playersPanelDisplayPage = {
  render(overrides: Partial<PlayersPanelDisplayProps> = {}) {
    const props = buildPlayersPanelDisplayProps(overrides);
    render(<PlayersPanelDisplay {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The fetcher and wrapper page objects spread this
   * to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
