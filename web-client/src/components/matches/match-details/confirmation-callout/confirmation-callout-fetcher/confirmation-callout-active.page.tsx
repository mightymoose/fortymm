import {
  mockMatchAcceptanceEndpoint,
  type MatchAcceptanceResolver,
} from "@/mocks/endpoints/matches/match-acceptance.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import {
  ConfirmationCalloutActive,
  type ConfirmationCalloutActiveProps,
} from "./confirmation-callout-active";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-active/confirmation-callout-display.page";
import {
  buildActionableConfirmationView,
  buildAwaitingConfirmationView,
} from "./confirmation-callout-active/confirmation-callout-display.factory";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  // The active layer adds no DOM of its own — expose the display's queries.
  ...confirmationCalloutDisplayPage.within(container),
});

/**
 * Test page-object for `ConfirmationCalloutActive` — the layer that owns the
 * accept mutation. Tests stub
 * `POST /v1/matches/:matchId/results/:resultId/acceptance` and drive the CTA;
 * no GET stub is needed because the mutation's cache invalidation only
 * refetches *mounted* queries, and this harness mounts none.
 */
export const confirmationCalloutActivePage = {
  /** Stub `POST /v1/matches/:matchId/results/:resultId/acceptance`. */
  mockAcceptanceEndpoint(resolver: MatchAcceptanceResolver) {
    mockMatchAcceptanceEndpoint(server, resolver);
  },

  /** The submitter's passive awaiting view. */
  awaitingView: buildAwaitingConfirmationView,

  render(overrides: Partial<ConfirmationCalloutActiveProps> = {}) {
    const props: ConfirmationCalloutActiveProps = {
      view: buildActionableConfirmationView(),
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };
    render(<ConfirmationCalloutActive {...props} />);
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
