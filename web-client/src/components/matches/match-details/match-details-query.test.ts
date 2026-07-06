import { HttpResponse } from "msw";

import { ApiError } from "@/api/client";
import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { LIVE_NEGOTIATION } from "@/mocks/match-store";
import { waitFor } from "@/test/utilities";

import type { Query } from "@tanstack/react-query";

import {
  matchDetailsQuery,
  matchDetailsResultFromPayload,
  refetchWhileAwaitingAcceptance,
  type MatchDetailsResult,
} from "./match-details-query";
import { matchDetailsQueryPage } from "./match-details-query.page";

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
  it("throws on error so route-level error boundaries catch failures", () => {
    expect(matchDetailsQuery("m-1").throwOnError).toBe(true);
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
