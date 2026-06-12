import { useQuery } from "@tanstack/react-query";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { renderHook } from "@/test/utilities";

import { playersPanelQuery } from "./players-panel-query";

const DEFAULT_MATCH_ID = "m-1";

/**
 * Test page-object for `playersPanelQuery`. The query is built on top of
 * `matchDetailsQuery` and projects a `PlayersPanelView` off the full
 * match-details payload via `select`, so the test stubs the same
 * `GET /v1/matches/:matchId` endpoint and asserts on the projected view.
 */
export const playersPanelQueryPage = {
  /**
   * Stub `GET /v1/matches/:matchId` with a full MSW resolver, so the test owns
   * the response — `HttpResponse.json(buildMatchDetails())` for the happy
   * path, a non-2xx for the error branch. It's the same endpoint
   * `matchDetailsQuery` reads from; the panel view is derived client-side.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /**
   * Run the query under the shared retry-free test client. `throwOnError` is
   * disabled here so failures land on `result.current.error` rather than
   * bubbling to an error boundary — boundary behavior is covered by the
   * fetcher tests. `result.current.data` is the projected `PlayersPanelView`.
   */
  render(matchId: string = DEFAULT_MATCH_ID) {
    return renderHook(() =>
      useQuery({ ...playersPanelQuery(matchId), throwOnError: false }),
    );
  },
};
