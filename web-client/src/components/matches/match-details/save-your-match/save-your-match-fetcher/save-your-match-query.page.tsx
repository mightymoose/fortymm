import { useQuery } from "@tanstack/react-query";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { renderHook } from "@/test/utilities";

import { saveYourMatchQuery } from "./save-your-match-query";

const DEFAULT_MATCH_ID = "m-1";

/**
 * Test page-object for `saveYourMatchQuery`. The query is built on top of
 * `matchDetailsQuery` and projects a `SaveYourMatchView | null` off the full
 * match-details payload via `select` (null = the guest prompt is hidden), so
 * the test stubs the same `GET /v1/matches/:matchId` endpoint and asserts on
 * the projected view.
 */
export const saveYourMatchQueryPage = {
  /**
   * Stub `GET /v1/matches/:matchId` with a full MSW resolver, so the test owns
   * the response. It's the same endpoint `matchDetailsQuery` reads from; the
   * save-your-match view is derived client-side.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /**
   * Run the query under the shared retry-free test client. `throwOnError` is
   * disabled so failures land on `result.current.error` rather than bubbling
   * to an error boundary. `result.current.data` is the projected
   * `SaveYourMatchView` (or null when the prompt shouldn't render).
   */
  render(matchId: string = DEFAULT_MATCH_ID) {
    return renderHook(() =>
      useQuery({ ...saveYourMatchQuery(matchId), throwOnError: false }),
    );
  },
};
