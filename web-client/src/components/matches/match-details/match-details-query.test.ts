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
import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { mockMatchDetailsEndpoint } from "@/mocks/endpoints/matches/match-details.endpoint";
import { server } from "@/mocks/server";
import { LIVE_NEGOTIATION } from "@/mocks/match-store";
import { RenderBoundary, waitFor } from "@/test/utilities";

import {
  matchDetailsQuery,
  matchDetailsResultFromPayload,
  refetchWhileAwaitingAcceptance,
  type MatchDetailsResult,
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
      refetchWhileAwaitingAcceptance,
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

  it("returns the parsed scoreboard view", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual({
      scoreboard: { status: match.data.scoreboard.status },
    });
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
