import {
  mockMatchResultsEndpoint,
  type MatchResultsResolver,
} from "@/mocks/endpoints/matches/match-results.endpoint";
import { server } from "@/mocks/server";
import { render, screen, type Container } from "@/test/utilities";

import {
  FinalizeCalloutActive,
  type FinalizeCalloutActiveProps,
} from "./finalize-callout-active";
import { finalizeCalloutDisplayPage } from "./finalize-callout-active/finalize-callout-display.page";
import { buildFinalizeCalloutView } from "./finalize-callout-active/finalize-callout-display.factory";

const DEFAULT_MATCH_ID = "m-1";

const scoped = (container: Container) => ({
  // The active layer adds no DOM of its own — expose the display's queries.
  ...finalizeCalloutDisplayPage.within(container),
});

/**
 * Test page-object for `FinalizeCalloutActive` — the layer that owns the
 * `useFinalizeMatch` mutation. Tests stub `POST /v1/matches/:matchId/results`
 * and drive the Post button; no GET stub is needed because the mutation's
 * cache invalidation only refetches *mounted* queries, and this harness
 * mounts none.
 */
export const finalizeCalloutActivePage = {
  /**
   * Stub `POST /v1/matches/:matchId/results` —
   * `HttpResponse.json(buildMatchDetails())` for the happy path, a non-2xx
   * with a `detail` body to drive the inline error.
   */
  mockResultsEndpoint(resolver: MatchResultsResolver) {
    mockMatchResultsEndpoint(server, resolver);
  },

  render(overrides: Partial<FinalizeCalloutActiveProps> = {}) {
    const props: FinalizeCalloutActiveProps = {
      view: buildFinalizeCalloutView(),
      matchId: DEFAULT_MATCH_ID,
      ...overrides,
    };
    render(<FinalizeCalloutActive {...props} />);
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
