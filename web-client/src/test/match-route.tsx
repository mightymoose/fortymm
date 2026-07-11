import type { ReactNode } from "react";

import { renderWithRoutes } from "@/test/router";

/**
 * Render `ui` under a minimal memory router that registers the
 * `/matches/$matchId` route. Components that contain a typed `<Link>` to a
 * match (e.g. a head-to-head meeting row) need the route present so the link
 * resolves at render time. The router loads asynchronously, so first reads
 * should await an async finder.
 *
 * A named special case of `renderWithRoutes` — the same harness, with the one
 * link target these components need already filled in.
 */
export function renderUnderMatchRoute(ui: ReactNode) {
  return renderWithRoutes(ui, { linkTargets: ["/matches/$matchId"] });
}
