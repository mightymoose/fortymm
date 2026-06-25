import { useQuery } from "@tanstack/react-query";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { renderHook } from "@/test/utilities";

import { disputeNoticeQuery } from "./dispute-notice-query";

const DEFAULT_MATCH_ID = "m-1";

/**
 * Test page-object for `disputeNoticeQuery`. The query is built on top of
 * `matchDetailsQuery` and projects a `DisputeNoticeView | null` off the full
 * match-details payload via `select` (null = the notice doesn't apply to this
 * viewer), so the test stubs the same `GET /v1/matches/:matchId` endpoint and
 * asserts on the projected view.
 */
export const disputeNoticeQueryPage = {
  /**
   * Stub `GET /v1/matches/:matchId` with a full MSW resolver, so the test owns
   * the response. It's the same endpoint `matchDetailsQuery` reads from; the
   * dispute notice is derived client-side.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /**
   * Run the query under the shared retry-free test client. `throwOnError` is
   * disabled so failures land on `result.current.error` rather than bubbling to
   * an error boundary. `result.current.data` is the projected
   * `DisputeNoticeView` (or null when the notice shouldn't render).
   */
  render(matchId: string = DEFAULT_MATCH_ID) {
    return renderHook(() =>
      useQuery({ ...disputeNoticeQuery(matchId), throwOnError: false }),
    );
  },
};
