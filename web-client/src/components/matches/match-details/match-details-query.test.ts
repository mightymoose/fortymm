import { createElement } from "react";
import { HttpResponse } from "msw";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  type Query,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";

import { ApiError } from "@/api/client";
import {
  buildMatchDetails,
  buildMatchDetailsSide,
} from "@/mocks/factories/matches/match-details.factory";
import { mockMatchDetailsEndpoint } from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { LIVE_NEGOTIATION } from "@/mocks/match-store";
import { RenderBoundary, waitFor } from "@/test/utilities";

import {
  matchDetailsQuery,
  matchDetailsRefetchInterval,
  matchDetailsResultFromPayload,
  refetchWhileAwaitingAcceptance,
  refetchWhileAwaitingCall,
  type MatchDetailsResult,
  type MatchNotScorableReason,
} from "./match-details-query";
import { matchDetailsQueryPage } from "./match-details-query.page";

// A long staleTime means a re-read only refetches if something explicitly
// invalidates the query, so the #1468 regression pair's background refetch is
// the one that fires, not an incidental stale-by-default refetch. Only the
// #1468 pair uses this client; the other tests below drive
// `matchDetailsQueryPage`'s own harness instead.
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});

afterEach(() => {
  queryClient.clear();
});

/** Reads the real `matchDetailsQuery(...)` options (not the page object's
 * `throwOnError: false` override) so the throw-vs-keep behavior under test is
 * the one production callers actually see. */
function MatchDetailsView({ matchId }: { matchId: string }) {
  const { data } = useQuery(matchDetailsQuery(matchId));
  return createElement(
    "div",
    null,
    data ? `status:${data.data.scoreboard.status}` : "PENDING",
  );
}

function matchDetailsTree(matchId: string) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(RenderBoundary, null, createElement(MatchDetailsView, { matchId })),
  );
}

const queryWithStatusLabel = (
  status_label: string,
  overrides: Parameters<typeof buildMatchDetails>[0] = {},
): Pick<Query<MatchDetailsResult>, "state"> => ({
  state: {
    data: matchDetailsResultFromPayload(
      buildMatchDetails({ status_label, ...overrides }),
    ),
  } as Query<MatchDetailsResult>["state"],
});

const queryWithNotScorableReason = (
  not_scorable_reason: MatchNotScorableReason | null,
  overrides: Parameters<typeof buildMatchDetails>[0] = {},
): Pick<Query<MatchDetailsResult>, "state"> => ({
  state: {
    data: matchDetailsResultFromPayload(
      buildMatchDetails({ not_scorable_reason, ...overrides }),
    ),
  } as Query<MatchDetailsResult>["state"],
});

describe("matchDetailsQuery", () => {
  it("throws only when there is no cached data to fall back on", () => {
    expect(typeof matchDetailsQuery("m-1").throwOnError).toBe("function");
  });

  /**
   * Regression (#1468 — mirrors #843's fix in `matchQueryOptions`): a
   * background refetch of an already-rendered match must not throw the
   * scoreboard out to the route error boundary. `throwOnError` is
   * re-evaluated on every render, so a bare `true` would eject the viewer the
   * next time anything else re-renders the page after a failed background
   * refetch.
   */
  it("keeps last-good data on screen when a background refetch fails (#1468)", async () => {
    const matchId = "m-bg-refetch";
    const seeded = buildMatchDetails({
      id: matchId,
      data: { scoreboard: { status: "live" } },
    });
    queryClient.setQueryData(
      matchDetailsQuery(matchId).queryKey,
      matchDetailsResultFromPayload(seeded),
    );

    const { rerender } = render(matchDetailsTree(matchId));
    expect(screen.getByText("status:live")).toBeTruthy();

    mockMatchDetailsEndpoint(server, () => new HttpResponse(null, { status: 500 }));

    await act(async () => {
      await queryClient
        .invalidateQueries({ queryKey: matchDetailsQuery(matchId).queryKey })
        .catch(() => undefined);
    });
    // The errored refetch alone doesn't re-render this observer (data/isLoading
    // are unchanged) — force the next render, where a bare `true` would throw.
    rerender(matchDetailsTree(matchId));

    expect(screen.queryByText("BOUNDARY")).toBeNull();
    expect(screen.getByText("status:live")).toBeTruthy();
  });

  /** The other half: an initial load with no cached data to fall back on must
   * still throw so the surrounding boundary can render a retry. */
  it("throws to the boundary when the initial match load fails", async () => {
    const matchId = "m-initial-fail";
    mockMatchDetailsEndpoint(server, () => new HttpResponse(null, { status: 500 }));

    render(matchDetailsTree(matchId));

    await waitFor(() => expect(screen.getByText("BOUNDARY")).toBeTruthy());
  });

  it("polls while awaiting the opponent's acceptance (#493)", () => {
    // The proposer posts a result and leaves the page open; the opponent
    // accepts in a different session, so nothing invalidates this cache.
    // Polling is the only thing that flips the page off "Awaiting acceptance".
    expect(matchDetailsQuery("m-1").refetchInterval).toBe(
      matchDetailsRefetchInterval,
    );
    expect(
      refetchWhileAwaitingAcceptance(
        queryWithStatusLabel("Awaiting acceptance"),
      ),
    ).toBeGreaterThan(0);
  });

  it.each(["Scheduled", "Live", "Final", "In review", "Voided"])(
    "stops polling once the match settles (%s)",
    (label) => {
      expect(
        refetchWhileAwaitingAcceptance(queryWithStatusLabel(label)),
      ).toBe(false);
    },
  );

  it("does not poll while it's the viewer's turn to act, so a correction can't swap the result out from under them (#726)", () => {
    // A standing result is still in play (label "Awaiting acceptance"), but
    // `your_turn` means the viewer is reviewing it. Polling here would silently
    // replace the reviewed result with a freshly-posted correction, and the
    // still-rendered Accept would finalize a result the viewer never saw.
    expect(
      refetchWhileAwaitingAcceptance(
        queryWithStatusLabel("Awaiting acceptance", {
          negotiation: {
            ...LIVE_NEGOTIATION,
            viewer_state: "review",
            your_turn: true,
          },
        }),
      ),
    ).toBe(false);
  });

  it("keeps polling for a spectator on an awaiting match (your_turn=false)", () => {
    // Spectators share this query for the scoreboard and get `your_turn=false`,
    // so suppressing the viewer's poll must not freeze theirs.
    expect(
      refetchWhileAwaitingAcceptance(
        queryWithStatusLabel("Awaiting acceptance", {
          negotiation: {
            ...LIVE_NEGOTIATION,
            viewer_state: "review",
            your_turn: false,
          },
        }),
      ),
    ).toBeGreaterThan(0);
  });

  it("does not poll before any data has loaded", () => {
    expect(
      refetchWhileAwaitingAcceptance({
        state: { data: undefined } as Query<MatchDetailsResult>["state"],
      }),
    ).toBe(false);
  });

  /** #1288: a participant's match page shows the "waiting to be called"
   * banner while `not_scorable_reason === 'not_called'`; nothing else
   * invalidates their cache once the director calls the fixture in a
   * different session, so this poll is what flips the Score CTA on without a
   * manual reload. */
  it("polls for a participant while the match hasn't been called (#1288)", () => {
    expect(
      refetchWhileAwaitingCall(
        queryWithNotScorableReason("not_called", {
          sides: [
            buildMatchDetailsSide({ is_current_user_side: true }),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: false,
            }),
          ],
        }),
      ),
    ).toBeGreaterThan(0);
  });

  it("does not poll a spectator on an uncalled match — they see no banner to refresh", () => {
    expect(
      refetchWhileAwaitingCall(
        queryWithNotScorableReason("not_called", {
          sides: [
            buildMatchDetailsSide({ is_current_user_side: false }),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: false,
            }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not poll a participant once the tournament is archived — a fixture there will never be called", () => {
    expect(
      refetchWhileAwaitingCall(
        queryWithNotScorableReason("not_called", {
          sides: [
            buildMatchDetailsSide({ is_current_user_side: true }),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: false,
            }),
          ],
          tournament: {
            tournament_id: "t-archived",
            tournament_name: "Summer Smash",
            tournament_status: "archived",
            event_id: "e-1",
            event_name: "Open Singles",
            table_label: null,
            can_edit: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it.each(["result_posted", "no_opponent", "not_scorable", null] as const)(
    "does not poll once the match is scorable or unscorable for a reason other than not_called (%s)",
    (reason) => {
      expect(
        refetchWhileAwaitingCall(queryWithNotScorableReason(reason)),
      ).toBe(false);
    },
  );

  it("does not poll for a call before any data has loaded", () => {
    expect(
      refetchWhileAwaitingCall({
        state: { data: undefined } as Query<MatchDetailsResult>["state"],
      }),
    ).toBe(false);
  });

  it("matchDetailsRefetchInterval polls when either predicate would", () => {
    expect(
      matchDetailsRefetchInterval(
        queryWithNotScorableReason("not_called", {
          sides: [
            buildMatchDetailsSide({ is_current_user_side: true }),
            buildMatchDetailsSide({
              side_number: 2,
              is_current_user_side: false,
            }),
          ],
        }),
      ),
    ).toBeGreaterThan(0);
    expect(
      matchDetailsRefetchInterval(
        queryWithStatusLabel("Awaiting acceptance"),
      ),
    ).toBeGreaterThan(0);
    expect(
      matchDetailsRefetchInterval(queryWithStatusLabel("Live")),
    ).toBe(false);
  });

  it("returns the parsed scoreboard view", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual({
      scoreboard: { status: match.data.scoreboard.status },
    });
  });

  /** #1288: `tournament` and `not_scorable_reason` are parsed at the boundary
   * (not read off `unmigrated`) so every selector built on them gets a
   * runtime, not just compile-time, guarantee. */
  it("parses tournament and not_scorable_reason onto the result", async () => {
    const match = buildMatchDetails({
      not_scorable_reason: "not_called",
      tournament: {
        tournament_id: "t-1",
        tournament_name: "Summer Smash",
        tournament_status: "live",
        event_id: "e-1",
        event_name: "Open Singles",
        table_label: "Table 3",
        can_edit: true,
      },
    });
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.not_scorable_reason).toBe("not_called");
    expect(result.current.data?.tournament).toEqual({
      tournament_id: "t-1",
      tournament_name: "Summer Smash",
      tournament_status: "live",
      event_id: "e-1",
      event_name: "Open Singles",
      table_label: "Table 3",
      can_edit: true,
    });
  });

  it("normalizes an absent tournament to null rather than undefined", async () => {
    const match = buildMatchDetails({ not_scorable_reason: null });
    // `tournament` omitted entirely — the wire field is optional as well as
    // nullable; a casual match's payload doesn't carry the key at all.
    delete (match as { tournament?: unknown }).tournament;
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.tournament).toBeNull();
  });

  it("keeps the full raw response on `unmigrated`", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The whole payload survives the parse — sides, games, etc., not just `data`.
    expect(result.current.data?.unmigrated).toEqual(match);
    expect(result.current.data?.unmigrated.sides).toHaveLength(
      match.sides.length,
    );
  });

  it("surfaces an error when the payload fails validation", async () => {
    const malformed = buildMatchDetails({
      data: { scoreboard: { status: "not-a-real-status" as never } },
    });
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(malformed));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("surfaces an ApiError when the request fails", async () => {
    matchDetailsQueryPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    const { result } = matchDetailsQueryPage.render("m-1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(500);
    // No detail body, so the message falls back to the labelled action.
    expect((result.current.error as ApiError).message).toBe(
      "Failed to load match m-1",
    );
  });
});

describe("matchDetailsResultFromPayload", () => {
  it("produces the same shape the queryFn resolves to, so a seeded cache reads identically", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Seeding from the payload the create response already holds yields exactly
    // what a fresh fetch would have cached — no GET required (#510).
    expect(matchDetailsResultFromPayload(match)).toEqual(result.current.data);
  });

  it("throws on a malformed payload rather than priming a bad cache entry", () => {
    const malformed = buildMatchDetails({
      data: { scoreboard: { status: "not-a-real-status" as never } },
    });
    expect(() => matchDetailsResultFromPayload(malformed)).toThrow();
  });
});
