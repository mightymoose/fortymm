import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { render, screen, type Container } from "@/test/utilities";

import {
  ConfirmationCalloutDisplay,
  type ConfirmationCalloutDisplayProps,
} from "./confirmation-callout-display";
import { buildConfirmationCalloutDisplayProps } from "./confirmation-callout-display.factory";
import { retirementCountdownPage } from "@/components/retirement-countdown/retirement-countdown.page";

const scoped = (container: Container) => ({
  /** The callout `<section>` (any variant); absent when the view projected
   * to null upstream. */
  queryCallout() {
    return container.queryByTestId("match-confirm-callout");
  },
  getCallout() {
    return container.getByTestId("match-confirm-callout");
  },
  /** The featured variants' primary CTA — "Accept result" idle, "Accepting…"
   * in flight. Absent on the passive variants. */
  getAcceptButton() {
    return container.getByRole("button", { name: /accept/i });
  },
  queryAcceptButton() {
    return container.queryByRole("button", { name: /accept/i });
  },
  /** The "Reload" CTA that replaces Accept after a stale-result 409 (#726). */
  getReloadButton() {
    return container.getByRole("button", { name: /reload/i });
  },
  queryReloadButton() {
    return container.queryByRole("button", { name: /reload/i });
  },
  /** The "Suggest correction" link on the review variant. */
  querySuggestCorrectionLink() {
    return container.queryByTestId("match-confirm-callout-correct");
  },
  /** The "Counter" link on the corrected variant. */
  queryCounterLink() {
    return container.queryByTestId("match-confirm-callout-counter");
  },
  /** The "Edit result" link on the awaiting variant. */
  queryEditLink() {
    return container.queryByTestId("match-confirm-callout-edit");
  },
  /** The correction diff block, present only on the corrected variant. */
  queryDiff() {
    return container.queryByTestId("score-diff");
  },
  /** The inline API-failure line beneath the body copy; null when clean. */
  queryError() {
    return container.queryByRole("alert");
  },
  // The retirement countdown's own queries (`getCountdown` / `queryCountdown` /
  // `getTone`), scoped to this callout — present only when the view carries a
  // deadline on the review/corrected variants.
  ...retirementCountdownPage.within(container),
});

/** Test page-object for the pure `ConfirmationCalloutDisplay`. The callout's
 * correction affordances are typed `<Link>`s, so `render` mounts it under a
 * minimal router that registers the correction route they target. The router
 * resolves asynchronously, so tests that read a link start with a `findBy*`
 * (e.g. `await page.getCallout()` via `waitFor`). */
export const confirmationCalloutDisplayPage = {
  render(overrides: Partial<ConfirmationCalloutDisplayProps> = {}) {
    const props = buildConfirmationCalloutDisplayProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ConfirmationCalloutDisplay {...props} />,
    });
    // The correction route the "Suggest correction" / "Counter" / "Edit result"
    // links navigate to — registered so the typed <Link>s resolve at render.
    const correctRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/results/new",
      component: () => <div>correction-route</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, correctRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree.
   */
  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
