import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";

import { server } from "@/mocks/server";
import { sessionResponse } from "@/test/factories";
import { render, screen, type Container } from "@/test/utilities";

import {
  SaveYourMatchDisplay,
  type SaveYourMatchDisplayProps,
} from "./save-your-match-display";
import { buildSaveYourMatchDisplayProps } from "./save-your-match-display.factory";

const PROMPT_NAME = /^Save this match$/i;

// Counts `GET /v1/session` hits so absence tests can wait until the session
// query has actually resolved before asserting the prompt stayed hidden — a
// bare synchronous check would pass vacuously (nothing renders until session
// loads, so it can't tell "correctly hidden" from "not yet decided").
let sessionRequestCount = 0;

const scoped = (container: Container) => ({
  /** The full nudge card — a `<section>` region. Absent for a verified user,
   * a spectator (no view), or after dismissal. */
  queryPrompt() {
    return container.queryByRole("region", { name: PROMPT_NAME });
  },
  /** Find-first variant: session + router resolve async, so tests await this. */
  findPrompt() {
    return container.findByRole("region", { name: PROMPT_NAME });
  },
  /** The quiet receipt shown after "Not now" for the rest of the session. */
  queryReceipt() {
    return container.queryByRole("status", { name: /match save receipt/i });
  },
  getReceipt() {
    return container.getByRole("status", { name: /match save receipt/i });
  },
  /** Primary CTA into the settings email section. */
  getSaveCta() {
    return container.getByRole("link", { name: /save this match/i });
  },
  /** Dismiss button — swaps the prompt for the receipt. */
  getNotNow() {
    return container.getByRole("button", { name: /not now/i });
  },
  /** "Save it" link inside the receipt — a real CTA, not a re-surface. */
  getReceiptSaveLink() {
    return container.getByRole("link", { name: /save it/i });
  },
  /** The "TAKES 20s · EMAIL ONLY" reassurance hint. */
  getHint() {
    return container.getByText(/TAKES 20s/);
  },
  /** The body copy paragraph — names the opponent in the rivalry line. */
  getBody() {
    return container.getByText(/Add an email and your rating/i);
  },
  /** The two score blips (viewer-first), e.g. ["3", "1"]. */
  getScoreBlips(): HTMLElement[] {
    return container.getAllByText(/^[0-9]+$/);
  },
  /** The two avatar chips (viewer-first), so tests can assert win/loss tones. */
  getAvatars(): HTMLElement[] {
    const anchor = container.getByLabelText(/match summary/i) as HTMLElement;
    return Array.from(
      anchor.querySelectorAll<HTMLElement>(".md-save__avatar"),
    );
  },
});

/**
 * Test page-object for `SaveYourMatchDisplay`. The display renders typed
 * `<Link>`s into `/settings` and reads `useSession()`, so `render` mounts it
 * under a minimal memory router that registers the settings route and the
 * test stubs `GET /v1/session` via `mockSession`. Session + router resolve
 * asynchronously, so tests start with `await saveYourMatchDisplayPage
 * .findPrompt()`.
 */
export const saveYourMatchDisplayPage = {
  /** Stub `GET /v1/session` — defaults to a guest (no email/confirmation). */
  mockSession(overrides: Parameters<typeof sessionResponse>[0] = {}) {
    sessionRequestCount = 0;
    server.use(
      http.get("*/v1/session", () => {
        sessionRequestCount += 1;
        return HttpResponse.json(sessionResponse(overrides));
      }),
    );
  },

  /** How many times the session endpoint has been hit since `mockSession` —
   * absence tests assert on this so they wait for the query to resolve. */
  sessionRequestCount() {
    return sessionRequestCount;
  },

  render(overrides: Partial<SaveYourMatchDisplayProps> = {}) {
    const props = buildSaveYourMatchDisplayProps(overrides);
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <SaveYourMatchDisplay {...props} />,
    });
    // Route stub the "Save this match" / "Save it" links navigate to.
    const settings = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings",
      component: () => <div>settings-page</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, settings]),
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
