import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import { GameGrid, type GameGridProps } from "./game-grid";
import { buildGameGridProps } from "./game-grid.factory";
import { gameGridRowPage } from "./game-grid/game-grid-row.page";

const scoped = (container: Container) => ({
  /** The grid block at the bottom of the hero; absent when the view's
   * `gameGrid` is null. */
  queryGrid() {
    return container.queryByTestId("scoreboard-game-grid");
  },
  getGrid() {
    return container.getByTestId("scoreboard-game-grid");
  },
  findGrid() {
    return container.findByTestId("scoreboard-game-grid");
  },
  /** The inner grid track laying out the columns — the `.md-games__grid` child
   * of the `.md-games` scroll container (the testid host). The track overflows
   * the container on narrow viewports, which is what makes the trailing SETS
   * column reachable by scroll instead of clipped off-screen (#509). */
  getGridTrack() {
    return container
      .getByTestId("scoreboard-game-grid")
      .querySelector(".md-games__grid") as HTMLElement | null;
  },
  ...gameGridRowPage.within(container),
});

/**
 * Test page-object for `GameGrid` — the per-game score grid at the bottom of
 * the scoreboard. Scored cells on the viewer's row can render typed `<Link>`s
 * to the scores/edit route, so `render` mounts the grid under a minimal router
 * that registers that route — mirroring the harness the match-details page
 * object builds. The router resolves asynchronously, so tests start with
 * `await gameGridPage.findGrid()`.
 */
export const gameGridPage = {
  render(overrides: Partial<GameGridProps> = {}) {
    const props = buildGameGridProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <GameGrid {...props} />,
    });
    // Route stub the edit links navigate to — registered so typed <Link>s in
    // the grid resolve at render time.
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
   * Scope the grid accessors to a container — the whole `screen` (default) or
   * a `within(node)` subtree. Page objects that embed the grid (the scoreboard
   * display, fetcher, and wrapper) call this to expose the same queries as
   * their own `.gameGrid`, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
