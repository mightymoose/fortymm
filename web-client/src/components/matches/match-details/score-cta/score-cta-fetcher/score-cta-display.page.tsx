import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import { ScoreCtaDisplay, type ScoreCtaDisplayProps } from "./score-cta-display";
import { buildScoreCtaDisplayProps } from "./score-cta-display.factory";

const scoped = (container: Container) => ({
  /** The "Score" button — a typed `<Link>` into the score-entry route. */
  getScoreLink() {
    return container.getByRole("link", { name: "Score" });
  },
  findScoreLink() {
    return container.findByRole("link", { name: "Score" });
  },
});

/**
 * Test page-object for `ScoreCtaDisplay`. The CTA is a typed `<Link>`, so
 * `render` mounts it under a minimal router that registers the score-entry
 * route the link targets. The router resolves asynchronously, so tests start
 * with `await scoreCtaDisplayPage.findScoreLink()`.
 */
export const scoreCtaDisplayPage = {
  render(overrides: Partial<ScoreCtaDisplayProps> = {}) {
    const props = buildScoreCtaDisplayProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ScoreCtaDisplay {...props} />,
    });
    // Route stub the "Score" link navigates to — registered so the typed
    // <Link> resolves at render time.
    const scoringNew = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/games/$gameNumber/scores/new",
      component: () => <div>scoring-new</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, scoringNew]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Parent page objects spread this to expose the
   * same queries as their own.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
