import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { render } from "@/test/utilities";

/**
 * Render `ui` under a minimal memory router that registers the
 * `/matches/$matchId` route. Components that contain a typed `<Link>` to a
 * match (e.g. a head-to-head meeting row) need the route present so the link
 * resolves at render time. The router loads asynchronously, so first reads
 * should await an async finder.
 */
export function renderUnderMatchRoute(ui: ReactNode) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const matchDetail = createRoute({
    getParentRoute: () => rootRoute,
    path: "/matches/$matchId",
    component: () => <div>match-detail</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, matchDetail]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}
