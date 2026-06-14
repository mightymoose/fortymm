import { render, screen, type Container } from "@/test/utilities";

import { ScoreCell, type ScoreCellProps } from "./score-cell";
import { buildScoreCellProps } from "./score-cell.factory";

const scoped = (container: Container) => ({
  /** The pending placeholder — the em-dash span (`.score-cell.pending`) shown
   * when `view.games` is null. Absent when a games score is present. */
  getPendingScore() {
    return container.getByText("—");
  },
  queryPending() {
    return container.queryByText("—");
  },
  /** The games-won span (`.score-cell.games`) showing the 'a–b' string. Absent
   * (renders '—' instead) when `view.games` is null. */
  getGamesScore() {
    return container.getByText((_content: string, element: Element | null) =>
      element?.className === "score-cell games",
    );
  },
  queryGames() {
    return container.queryByText((_content: string, element: Element | null) =>
      element?.className === "score-cell games",
    );
  },
});

/**
 * Test page-object for `ScoreCell` — the games-won cell in a match row. No
 * router harness (it renders a plain span), so tests can use the synchronous
 * `get`/`query` accessors directly.
 */
export const scoreCellPage = {
  render(overrides: Partial<ScoreCellProps> = {}) {
    const props = buildScoreCellProps(overrides);
    render(<ScoreCell {...props} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Row page objects spread this to expose the same
   * queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
