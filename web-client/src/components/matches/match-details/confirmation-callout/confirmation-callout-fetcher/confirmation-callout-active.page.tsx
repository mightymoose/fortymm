import {
  mockMatchConfirmationEndpoint,
  type MatchConfirmationResolver,
} from "@/mocks/endpoints/matches/match-confirmation.endpoint";
import {
  mockMatchDisputeEndpoint,
  type MatchDisputeResolver,
} from "@/mocks/endpoints/matches/match-dispute.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import {
  ConfirmationCalloutActive,
  type ConfirmationCalloutActiveProps,
} from "./confirmation-callout-active";
import { confirmationCalloutDisplayPage } from "./confirmation-callout-active/confirmation-callout-display.page";
import { buildActionableConfirmationView } from "./confirmation-callout-active/confirmation-callout-display.factory";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  // The active layer adds no DOM of its own — expose the display's queries.
  ...confirmationCalloutDisplayPage.within(container),
});

/**
 * Test page-object for `ConfirmationCalloutActive` — the layer that owns the
 * confirm/dispute mutations. Tests stub `POST /v1/matches/:matchId/confirmation`
 * and `.../dispute` and drive the CTAs; no GET stub is needed because the
 * mutations' cache invalidation only refetches *mounted* queries, and this
 * harness mounts none.
 */
export const confirmationCalloutActivePage = {
  /** Stub `POST /v1/matches/:matchId/confirmation`. */
  mockConfirmationEndpoint(resolver: MatchConfirmationResolver) {
    mockMatchConfirmationEndpoint(server, resolver);
  },

  /** Stub `POST /v1/matches/:matchId/dispute`. */
  mockDisputeEndpoint(resolver: MatchDisputeResolver) {
    mockMatchDisputeEndpoint(server, resolver);
  },

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
