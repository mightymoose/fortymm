import { useQuery } from "@tanstack/react-query";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { renderHook } from "@/test/utilities";

import { matchDetailsQuery } from "./match-details-query";

const DEFAULT_MATCH_ID = "m-1";

/**
 * Test page-object for `matchDetailsQuery`. Stub the endpoint with
 * `mockEndpoint`, then `render` to drive the query and assert on the returned
 * `{ data, unmigrated }` view (or the surfaced error).
 */
export const matchDetailsQueryPage = {
  /**
   * Stub `GET /v1/matches/:matchId` with a full MSW resolver, so the test owns
   * the response — `HttpResponse.json(buildMatchDetails())` for the happy path,
   * a malformed body for the parse branch, or a non-2xx for the error branch.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /**
   * Run the query under the shared retry-free test client. `throwOnError` is
   * disabled here so failures land on `result.current.error` rather than
   * bubbling to an error boundary — boundary behavior is covered at the route
   * level.
   */
  render(matchId: string = DEFAULT_MATCH_ID) {
    return renderHook(() =>
      useQuery({ ...matchDetailsQuery(matchId), throwOnError: false }),
    );
  },
};
