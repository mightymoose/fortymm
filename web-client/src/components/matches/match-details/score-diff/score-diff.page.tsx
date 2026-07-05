import { render, screen, type Container } from "@/test/utilities";

import { ScoreDiff, type ScoreDiffProps } from "./score-diff";
import { buildScoreDiffProps } from "./score-diff.factory";

const scoped = (container: Container) => ({
  /** The diff block itself; always present (even for an empty diff). */
  queryDiff() {
    return container.queryByTestId("score-diff");
  },
  getDiff() {
    return container.getByTestId("score-diff");
  },
  /** The row for game `n`; absent when that game is unchanged (not in diff). */
  queryEntry(gameNumber: number) {
    return container.queryByTestId(`score-diff-entry-${gameNumber}`);
  },
  getEntry(gameNumber: number) {
    return container.getByTestId(`score-diff-entry-${gameNumber}`);
  },
  /** The struck-through old score for game `n`; absent when the game is new. */
  queryOld(gameNumber: number) {
    return container.queryByTestId(`score-diff-old-${gameNumber}`);
  },
  /** The emphasized new score for game `n`. */
  getNew(gameNumber: number) {
    return container.getByTestId(`score-diff-new-${gameNumber}`);
  },
  /** The emphasized new score for game `n`; absent when the game was removed. */
  queryNew(gameNumber: number) {
    return container.queryByTestId(`score-diff-new-${gameNumber}`);
  },
  /** The "new game" tag rendered only for added games (`old === null`). */
  queryAddedTag(gameNumber: number) {
    return container.queryByTestId(`score-diff-added-${gameNumber}`);
  },
  /** The "removed game" tag rendered only for removed games (`new === null`). */
  queryRemovedTag(gameNumber: number) {
    return container.queryByTestId(`score-diff-removed-${gameNumber}`);
  },
});

/**
 * Test page-object for `ScoreDiff` — the per-game correction diff rendered from
 * `negotiation.diff`. Purely presentational, so `render` mounts the component
 * directly with no router or providers.
 */
export const scoreDiffPage = {
  render(overrides: Partial<ScoreDiffProps> = {}) {
    const props = buildScoreDiffProps(overrides);
    render(<ScoreDiff {...props} />);
  },

  /**
   * Scope the diff accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed the diff (the corrected
   * callout, #719) call this to expose the same queries as their own.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
