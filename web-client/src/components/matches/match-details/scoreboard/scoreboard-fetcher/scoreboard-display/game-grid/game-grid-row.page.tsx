import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import { gameGridCellPage } from "./game-grid-row/game-grid-cell.page";
import { GameGridRow, type GameGridRowProps } from "./game-grid-row";
import { buildGameGridRowProps } from "./game-grid-row.factory";

const scoped = (container: Container) => ({
  /** A row's player-name label; rows are perspective-ordered, viewer first. */
  getPlayerName(rowSide: "left" | "right") {
    return container.getByTestId(`scoreboard-game-grid-player-${rowSide}`);
  },
  findPlayerName(rowSide: "left" | "right") {
    return container.findByTestId(`scoreboard-game-grid-player-${rowSide}`);
  },
  /** A row's avatar chip — the player's initials, or the dashed placeholder
   * icon on a ghost row. */
  getAvatar(rowSide: "left" | "right") {
    return container.getByTestId(`scoreboard-game-grid-avatar-${rowSide}`);
  },
  /** A row's SETS total. */
  getTotal(rowSide: "left" | "right") {
    return container.getByTestId(`scoreboard-game-grid-total-${rowSide}`);
  },
  ...gameGridCellPage.within(container),
});

/**
 * Test page-object for `GameGridRow` — one side's row of the grid. The row
 * renders fragment children destined for the grid's CSS grid, and its scored
 * cells can carry typed `<Link>`s, so `render` mounts it under the same
 * minimal-router harness as `gameGridCellPage`. The router resolves
 * asynchronously, so tests start with
 * `await gameGridRowPage.findPlayerName(...)`.
 */
export const gameGridRowPage = {
  render(overrides: Partial<GameGridRowProps> = {}) {
    const props = buildGameGridRowProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <GameGridRow {...props} />,
    });
    // Route stub the edit links navigate to — registered so typed <Link>s in
    // the row's cells resolve at render time.
    const scoringEdit = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/games/$gameNumber/scores/edit",
      component: () => <div>scoring-edit</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, scoringEdit]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  },

  /**
   * Scope the row accessors to a container — the whole `screen` (default) or
   * a `within(node)` subtree. The grid page object spreads this to expose the
   * same queries as its own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
