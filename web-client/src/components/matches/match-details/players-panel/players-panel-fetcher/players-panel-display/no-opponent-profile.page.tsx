import { render, screen, type Container } from "@/test/utilities";

import { NoOpponentProfile } from "./no-opponent-profile";

const scoped = (container: Container) => ({
  /** The ghost-toned "No opponent" name; absent when a real profile renders
   * that half of the panel. */
  getGhostName() {
    return container.getByText("No opponent", {
      selector: ".md-profile__name--ghost",
    });
  },
  queryGhostName() {
    return container.queryByText("No opponent", {
      selector: ".md-profile__name--ghost",
    });
  },
  /** The solo-match explainer line. */
  getSoloNote() {
    return container.getByText("Solo match — no second player.");
  },
  querySoloNote() {
    return container.queryByText("Solo match — no second player.");
  },
});

/**
 * Test page-object for `NoOpponentProfile` — the static "No opponent"
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
