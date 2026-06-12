import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import { GameGridCell, type GameGridCellProps } from "./game-grid-cell";
import { buildGameGridCellProps } from "./game-grid-cell.factory";

const scoped = (container: Container) => ({
  /** The cell for one game slot (1-based) on one row. A scored, editable cell
   * is an `<a>`; everything else is a plain div. */
  getCell(rowSide: "left" | "right", gameNumber: number) {
    return container.getByTestId(
      `scoreboard-game-grid-cell-${rowSide}-${gameNumber}`,
    );
  },
  findCell(rowSide: "left" | "right", gameNumber: number) {
    return container.findByTestId(
      `scoreboard-game-grid-cell-${rowSide}-${gameNumber}`,
    );
  },
});

/**
 * Test page-object for `GameGridCell` — one game slot in the grid. A scored,
 * editable cell renders a typed `<Link>` to the scores/edit route, so `render`
 * mounts the cell under a minimal router that registers that route. The router
 * resolves asynchronously, so tests start with
 * `await gameGridCellPage.findCell(...)`.
 */
export const gameGridCellPage = {
  render(overrides: Partial<GameGridCellProps> = {}) {
    const props = buildGameGridCellProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <GameGridCell {...props} />,
    });
    // Route stub the edit links navigate to — registered so typed <Link>s
    // resolve at render time.
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
   * Scope the cell accessors to a container — the whole `screen` (default) or
   * a `within(node)` subtree. The row page object spreads this to expose the
   * same queries as its own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
