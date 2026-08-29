import { useQuery } from "@tanstack/react-query";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { renderHook } from "@/test/utilities";

import { breadcrumbQuery } from "./breadcrumb-query";

const DEFAULT_MATCH_ID = "m-1";

/**
 * Test page-object for `breadcrumbQuery`. The query is built on top of
 * `matchDetailsQuery` and projects a `BreadcrumbTournamentView | null` off
 * the full match-details payload via `select`, so the test stubs the same
 * `GET /v1/matches/:matchId` endpoint and asserts on the projected view.
 */
export const breadcrumbQueryPage = {
  /**
   * Stub `GET /v1/matches/:matchId` with a full MSW resolver — the same
   * endpoint `matchDetailsQuery` reads from; the crumb is derived
   * client-side.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /**
   * Run the query under the shared retry-free test client. `throwOnError` is
   * disabled here so failures land on `result.current.error` rather than
   * bubbling to an error boundary — boundary behavior is covered at the
   * fetcher level.
   */
  render(matchId: string = DEFAULT_MATCH_ID) {
    return renderHook(() =>
      useQuery({ ...breadcrumbQuery(matchId), throwOnError: false }),
    );
  },
};
