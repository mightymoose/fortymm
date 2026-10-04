import { render, screen, type Container } from "@/test/utilities";

import { NoOpponentProfile } from "./no-opponent-profile";

const scoped = (container: Container) => ({
  /** The ghost-toned "Unlisted opponent" name; absent when a real profile renders
   * that half of the panel. */
  getGhostName() {
    return container.getByText("Unlisted opponent", {
      selector: ".md-profile__name--ghost",
    });
  },
  queryGhostName() {
    return container.queryByText("Unlisted opponent", {
      selector: ".md-profile__name--ghost",
    });
  },
  /** The line that explains what an unlisted opponent is. */
  getSoloNote() {
    return container.getByText("This player is not on FortyMM, or the match was played alone.");
  },
  querySoloNote() {
    return container.queryByText("This player is not on FortyMM, or the match was played alone.");
  },
});

/**
 * Test page-object for `NoOpponentProfile` — the static "Unlisted opponent"
 * placeholder half of the players panel. The component takes no props, so
 * there's no factory.
 */
export const noOpponentProfilePage = {
  render() {
    render(<NoOpponentProfile />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread
   * this to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
