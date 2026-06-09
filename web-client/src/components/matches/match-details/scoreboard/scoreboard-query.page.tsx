import { useQuery } from "@tanstack/react-query";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { renderHook } from "@/test/utilities";

import { scoreboardQuery } from "./scoreboard-query";

const DEFAULT_MATCH_ID = "m-1";

/**
 * Test page-object for `scoreboardQuery`. The query is built on top of
 * `matchDetailsQuery` and projects a `ScoreboardView` (`{ status, outcome }`)
 * off the full match-details payload via `select`, so the test stubs the same
 * `GET /v1/matches/:matchId` endpoint and asserts on the projected view.
 */
export const scoreboardQueryPage = {
  /**
   * Stub `GET /v1/matches/:matchId` with a full MSW resolver, so the test owns
   * the response — `HttpResponse.json(buildMatchDetails())` for the happy path,
   * a malformed body for the parse branch, or a non-2xx for the error branch.
   * It's the same endpoint `matchDetailsQuery` reads from; the scoreboard view
   * is derived client-side.
   */
  mockEndpoint(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /**
   * Run the query under the shared retry-free test client. `throwOnError` is
   * disabled here so failures land on `result.current.error` rather than
   * bubbling to an error boundary — boundary behavior is covered at the route
   * level. `result.current.data` is the projected `ScoreboardView`.
   */
  render(matchId: string = DEFAULT_MATCH_ID) {
    return renderHook(() =>
      useQuery({ ...scoreboardQuery(matchId), throwOnError: false }),
    );
  },
};
